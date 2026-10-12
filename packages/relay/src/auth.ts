import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type Database from 'better-sqlite3'
import { ProtocolError, validateId, type Clock } from '@dsh-web-control/protocol'
import { openDatabase, storageOperation } from './db.ts'

export const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000

export function hashSecret(secret: string): string {
  if (typeof secret !== 'string') throw new ProtocolError('INVALID_MESSAGE')
  return createHash('sha256').update(secret, 'utf8').digest('hex')
}

export function validateSecret(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)
    || Buffer.from(value, 'base64url').length !== 32 || Buffer.from(value, 'base64url').toString('base64url') !== value) {
    throw new ProtocolError('INVALID_MESSAGE')
  }
}

function validateVerifier(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) throw new ProtocolError('INVALID_MESSAGE')
}
function validateEpoch(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new ProtocolError('INVALID_MESSAGE')
}
function matches(secret: string, verifier: string): boolean {
  const actual = Buffer.from(hashSecret(secret), 'hex'), expected = Buffer.from(verifier, 'hex')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}
interface Device {
  device_verifier: string
  link_verifier: string
  auth_epoch: number
  enabled: number
  revoked: number
}
interface BrowserSession { instance_id: string; auth_epoch: number; expires_at: number }

/** Synchronous transactions persist authorization without an optimistic in-memory cache. */
export class AuthStore {
  private readonly db: Database.Database

  constructor(databasePath: string, private readonly clock: Clock, private readonly enrollmentVerifier: string) {
    validateVerifier(enrollmentVerifier)
    this.db = openDatabase(databasePath)
  }

  register(input: { enrollmentSecret: string; instanceId: string; deviceSecret: string; linkVerifier: string; authEpoch: number }): void {
    storageOperation(() => {
      validateId(input.instanceId); validateSecret(input.enrollmentSecret); validateSecret(input.deviceSecret)
      validateVerifier(input.linkVerifier); validateEpoch(input.authEpoch)
      if (!matches(input.enrollmentSecret, this.enrollmentVerifier)) throw new ProtocolError('AUTH_FAILED')
      this.db.transaction(() => {
        // Tombstones also count as existing: ordinary enrollment can never revive this identity.
        if (this.device(input.instanceId)) throw new ProtocolError('INSTANCE_EXISTS')
        this.db.prepare('INSERT INTO devices (id, device_verifier, link_verifier, auth_epoch, enabled) VALUES (?, ?, ?, ?, 1)')
          .run(input.instanceId, hashSecret(input.deviceSecret), input.linkVerifier, input.authEpoch)
      }).immediate()
    })
  }

  authenticateDevice(instanceId: string, deviceSecret: string): void {
    storageOperation(() => { this.authenticatedDevice(instanceId, deviceSecret) })
  }

  syncAuthorization(instanceId: string, deviceSecret: string, authEpoch: number, linkVerifier: string, enabled: boolean): void {
    storageOperation(() => {
      validateEpoch(authEpoch); validateVerifier(linkVerifier)
      if (typeof enabled !== 'boolean') throw new ProtocolError('INVALID_MESSAGE')
      this.db.transaction(() => {
        const device = this.authenticatedDevice(instanceId, deviceSecret)
        if (authEpoch < device.auth_epoch || (authEpoch === device.auth_epoch
          && (linkVerifier !== device.link_verifier || Number(enabled) !== device.enabled))) throw new ProtocolError('AUTH_EPOCH_CONFLICT')
        if (authEpoch === device.auth_epoch) return
        this.db.prepare('UPDATE devices SET auth_epoch = ?, link_verifier = ?, enabled = ? WHERE id = ?')
          .run(authEpoch, linkVerifier, Number(enabled), instanceId)
        this.db.prepare('DELETE FROM browser_sessions WHERE instance_id = ?').run(instanceId)
      }).immediate()
    })
  }

  login(instanceId: string, linkSecret: string): { sessionToken: string; expiresAt: number } {
    return storageOperation(() => {
      validateId(instanceId); validateSecret(linkSecret)
      return this.db.transaction(() => {
        const device = this.device(instanceId)
        if (!device) throw new ProtocolError('AUTH_FAILED')
        if (device.revoked || !device.enabled) throw new ProtocolError('AUTH_REVOKED')
        if (!matches(linkSecret, device.link_verifier)) throw new ProtocolError('AUTH_FAILED')
        const expiresAt = this.now() + SESSION_LIFETIME_MS
        if (!Number.isSafeInteger(expiresAt)) throw new ProtocolError('INVALID_MESSAGE')
        const sessionToken = randomBytes(32).toString('base64url')
        this.db.prepare('INSERT INTO browser_sessions (token_verifier, instance_id, auth_epoch, expires_at) VALUES (?, ?, ?, ?)')
          .run(hashSecret(sessionToken), instanceId, device.auth_epoch, expiresAt)
        return { sessionToken, expiresAt }
      }).immediate()
    })
  }

  authorize(instanceId: string, sessionToken: string): { authEpoch: number } {
    return storageOperation(() => {
      validateId(instanceId); validateSecret(sessionToken)
      // Both reads share a snapshot, so another connection cannot rotate between them.
      return this.db.transaction(() => {
        const session = this.db.prepare('SELECT instance_id, auth_epoch, expires_at FROM browser_sessions WHERE token_verifier = ?')
          .get(hashSecret(sessionToken)) as BrowserSession | undefined
        if (!session || session.instance_id !== instanceId) throw new ProtocolError('AUTH_REQUIRED')
        const device = this.device(instanceId)
        if (!device || device.revoked || !device.enabled || session.auth_epoch !== device.auth_epoch) throw new ProtocolError('AUTH_REVOKED')
        if (session.expires_at <= this.now()) throw new ProtocolError('AUTH_EXPIRED')
        return { authEpoch: device.auth_epoch }
      })()
    })
  }

  current(instanceId: string): { authEpoch: number; linkVerifier: string; enabled: boolean } {
    return storageOperation(() => {
      validateId(instanceId)
      const device = this.device(instanceId)
      if (!device || device.revoked) throw new ProtocolError('AUTH_REVOKED')
      return { authEpoch: device.auth_epoch, linkVerifier: device.link_verifier, enabled: !!device.enabled }
    })
  }

  logout(instanceId: string, sessionToken: string): void {
    this.authorize(instanceId, sessionToken)
    storageOperation(() => { this.db.prepare('DELETE FROM browser_sessions WHERE token_verifier = ?').run(hashSecret(sessionToken)) })
  }

  check(): void {
    storageOperation(() => {
      // Exercise the main database write path, then always roll back the private probe.
      // A killed probe is rolled back by SQLite recovery; no authorization row changes.
      const timeout = this.db.pragma('busy_timeout', { simple: true }) as number
      this.db.pragma('busy_timeout = 100')
      try {
        this.db.exec('BEGIN IMMEDIATE')
        try {
          this.db.prepare('SELECT version FROM schema_migrations').all()
          this.db.prepare('INSERT INTO schema_migrations (version) VALUES (-1)').run()
        } finally { this.db.exec('ROLLBACK') }
      } finally { this.db.pragma(`busy_timeout = ${timeout}`) }
    })
  }

  remove(instanceId: string): void {
    storageOperation(() => {
      validateId(instanceId)
      this.db.transaction(() => {
        this.db.prepare('UPDATE devices SET revoked = 1, enabled = 0 WHERE id = ?').run(instanceId)
        this.db.prepare('DELETE FROM browser_sessions WHERE instance_id = ?').run(instanceId)
      }).immediate()
    })
  }

  close(): void { storageOperation(() => { if (this.db.open) this.db.close() }) }

  private device(instanceId: string): Device | undefined {
    return this.db.prepare('SELECT device_verifier, link_verifier, auth_epoch, enabled, revoked FROM devices WHERE id = ?').get(instanceId) as Device | undefined
  }

  private authenticatedDevice(instanceId: string, deviceSecret: string): Device {
    validateId(instanceId); validateSecret(deviceSecret)
    const device = this.device(instanceId)
    if (!device) throw new ProtocolError('AUTH_FAILED')
    if (device.revoked) throw new ProtocolError('AUTH_REVOKED')
    if (!matches(deviceSecret, device.device_verifier)) throw new ProtocolError('AUTH_FAILED')
    // A stopped Host remains authenticated so it can synchronize the next authorization epoch.
    return device
  }

  private now(): number {
    const now = this.clock.now()
    if (!Number.isSafeInteger(now) || now < 0) throw new ProtocolError('INVALID_MESSAGE')
    return now
  }
}
