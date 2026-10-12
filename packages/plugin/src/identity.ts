import { randomBytes, randomUUID } from 'node:crypto'
import { ProtocolError, validateId } from '../../protocol/src/index.ts'
import type { CredentialStore } from './credential-store.ts'

/** Local credential material. Never serialize this object into protocol messages. */
export interface Identity {
  instanceId: string
  deviceSecret: string
  linkSecret: string
  authEpoch: number
  enabled: boolean
  relayOrigin: string
}

const identityFields = ['instanceId', 'deviceSecret', 'linkSecret', 'authEpoch', 'enabled', 'relayOrigin'] as const
const secret = (): string => randomBytes(32).toString('base64url')

/** Only the canonical-profile SHA-256 hash is accepted, never a directory or port. */
export function validateProfileScope(scope: string): void {
  if (typeof scope !== 'string' || !/^[0-9a-f]{64}$/.test(scope)) throw new ProtocolError('INVALID_PROFILE_SCOPE')
}

export function normalizeRelayOrigin(value: string): string {
  // Reject path/credential syntax before URL parsing can normalize it away.
  if (typeof value !== 'string' || !/^https:\/\/[^\s\\/@?#]+\/?$/i.test(value)) throw new ProtocolError('INVALID_RELAY_ORIGIN')
  let url: URL
  try { url = new URL(value) } catch { throw new ProtocolError('INVALID_RELAY_ORIGIN') }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash
    || value.includes('?') || value.includes('#')) throw new ProtocolError('INVALID_RELAY_ORIGIN')
  return url.origin
}

export function corruptIdentity(): never {
  throw new ProtocolError('IDENTITY_CORRUPT', 'Stored control identity is invalid; remote control is disabled. Repair the local credential record explicitly before enabling control; the existing record has been preserved.')
}

/** Validate every field, returning a detached value so callbacks cannot mutate storage. */
export function validateIdentity(value: unknown): Identity {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) corruptIdentity()
  const fields = Reflect.ownKeys(value)
  if (fields.length !== identityFields.length || fields.some(field => !identityFields.includes(field as typeof identityFields[number]))) corruptIdentity()
  const obj = value as Record<string, unknown>
  for (const field of identityFields) {
    const descriptor = Object.getOwnPropertyDescriptor(obj, field)
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) corruptIdentity()
  }
  try { validateId(obj.instanceId) } catch { corruptIdentity() }
  for (const field of ['deviceSecret', 'linkSecret']) {
    const value = obj[field]
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)
      || Buffer.from(value, 'base64url').length !== 32 || Buffer.from(value, 'base64url').toString('base64url') !== value) corruptIdentity()
  }
  if (!Number.isSafeInteger(obj.authEpoch) || (obj.authEpoch as number) < 1 || typeof obj.enabled !== 'boolean'
    || typeof obj.relayOrigin !== 'string') corruptIdentity()
  try { if (normalizeRelayOrigin(obj.relayOrigin) !== obj.relayOrigin) corruptIdentity() } catch { corruptIdentity() }
  return Object.fromEntries(identityFields.map(field => [field, obj[field]])) as unknown as Identity
}

function requireIdentity(old: Identity | undefined): Identity {
  if (!old) throw new ProtocolError('IDENTITY_MISSING', 'Enable remote control locally before changing its identity.')
  return validateIdentity(old)
}

function nextEpoch(old: Identity): number {
  if (old.authEpoch === Number.MAX_SAFE_INTEGER) throw new ProtocolError('AUTH_EPOCH_EXHAUSTED', 'Repair the local registration explicitly before changing authorization.')
  return old.authEpoch + 1
}

/** Every transition runs inside the store's atomic update, with no optimistic cache. */
export class IdentityManager {
  constructor(private readonly store: CredentialStore, private readonly scope: string) { validateProfileScope(scope) }

  async load(): Promise<Identity | undefined> {
    const identity = await this.store.read(this.scope)
    return identity === undefined ? undefined : validateIdentity(identity)
  }

  async enable(relayOrigin: string): Promise<Identity> {
    const origin = normalizeRelayOrigin(relayOrigin)
    return this.store.update(this.scope, old => {
      if (!old) return { instanceId: randomUUID(), deviceSecret: secret(), linkSecret: secret(), authEpoch: 1, enabled: true, relayOrigin: origin }
      const current = requireIdentity(old)
      if (current.relayOrigin !== origin) throw new ProtocolError('RELAY_REGISTRATION_REQUIRED', 'Changing relay origin requires explicit local device registration.')
      if (current.enabled) return current
      return { ...current, linkSecret: secret(), authEpoch: nextEpoch(current), enabled: true }
    })
  }

  /** Explicit local replacement only; persisted before any enrollment request. */
  async replace(relayOrigin: string): Promise<Identity> {
    const origin = normalizeRelayOrigin(relayOrigin)
    return this.store.update(this.scope, old => {
      if (old && requireIdentity(old).enabled) throw new ProtocolError('AUTH_REVOKED')
      return { instanceId: randomUUID(), deviceSecret: secret(), linkSecret: secret(), authEpoch: 1, enabled: true, relayOrigin: origin }
    })
  }

  async rotate(): Promise<Identity> {
    return this.store.update(this.scope, old => {
      const current = requireIdentity(old)
      return { ...current, linkSecret: secret(), authEpoch: nextEpoch(current) }
    })
  }

  async stop(): Promise<Identity> {
    return this.store.update(this.scope, old => {
      const current = requireIdentity(old)
      return { ...current, enabled: false, authEpoch: nextEpoch(current) }
    })
  }
}
