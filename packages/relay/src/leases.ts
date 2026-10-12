import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { ProtocolError, validateId, type Clock } from '@dsh-web-control/protocol'
import { hashSecret, validateSecret } from './auth.ts'

export interface Lease { id: string; resumeSecret: string; controlId: string; expiresAt: number }
interface StoredLease {
  id: string
  resumeVerifier: string
  controlId: string
  expiresAt: number
  online: boolean
}

/** Single-process, synchronous ownership. Socket admission must authenticate the instance first.
 * No timers are owned here: the server must sweep periodically and clear on disposal.
 */
export class LeaseTable {
  private readonly leases = new Map<string, StoredLease>()

  constructor(private readonly clock: Clock, private readonly ttlMs: number) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 0x7fffffff) throw new ProtocolError('INVALID_MESSAGE')
  }

  acquire(instanceId: string, resume?: { id: string; secret: string }, takeover = false): Lease {
    validateId(instanceId)
    if (resume !== undefined) { validateId(resume.id); validateSecret(resume.secret) }
    const now = this.now(), expiresAt = this.deadline(now)
    const current = this.live(instanceId, now)
    if (current && !takeover) {
      // Possessing copied storage never proves that the original socket is dead.
      if (current.online || !resume || resume.id !== current.id
        || !timingSafeEqual(Buffer.from(hashSecret(resume.secret), 'hex'), Buffer.from(current.resumeVerifier, 'hex'))) {
        throw new ProtocolError('REMOTE_BUSY')
      }
      const next: StoredLease = { ...current, controlId: randomUUID(), expiresAt, online: true }
      this.leases.set(instanceId, next)
      return { id: next.id, resumeSecret: resume.secret, controlId: next.controlId, expiresAt }
    }
    const resumeSecret = randomBytes(32).toString('base64url')
    const next: StoredLease = { id: randomUUID(), resumeVerifier: hashSecret(resumeSecret), controlId: randomUUID(), expiresAt, online: true }
    this.leases.set(instanceId, next)
    return { id: next.id, resumeSecret, controlId: next.controlId, expiresAt }
  }

  heartbeat(instanceId: string, controlId: string): void {
    validateId(instanceId); validateId(controlId)
    const now = this.now(), current = this.live(instanceId, now)
    if (!current || !current.online || current.controlId !== controlId) throw new ProtocolError('STALE_CONTROL')
    current.expiresAt = this.deadline(now)
  }

  /** Called only after the owning socket is confirmed disconnected. A close is not activity. */
  disconnected(instanceId: string, controlId: string): void {
    validateId(instanceId); validateId(controlId)
    const current = this.live(instanceId, this.now())
    if (current?.controlId === controlId) current.online = false
  }

  /** Explicit leave, attach failure or teardown. Old-generation release is harmless. */
  release(instanceId: string, controlId: string): void {
    validateId(instanceId); validateId(controlId)
    if (this.leases.get(instanceId)?.controlId === controlId) this.leases.delete(instanceId)
  }

  get(instanceId: string): Readonly<Omit<StoredLease, 'resumeVerifier'>> | undefined {
    validateId(instanceId)
    const current = this.live(instanceId, this.now())
    if (!current) return undefined
    const { resumeVerifier: _, ...lease } = current
    return lease
  }

  sweepExpired(): number {
    const now = this.now()
    let removed = 0
    for (const [instanceId, lease] of this.leases) if (lease.expiresAt <= now) { this.leases.delete(instanceId); removed++ }
    return removed
  }

  clear(): void { this.leases.clear() }

  private live(instanceId: string, now: number): StoredLease | undefined {
    const current = this.leases.get(instanceId)
    if (current && current.expiresAt <= now) { this.leases.delete(instanceId); return undefined }
    return current
  }

  private now(): number {
    const now = this.clock.now()
    if (!Number.isSafeInteger(now) || now < 0) throw new ProtocolError('INVALID_MESSAGE')
    return now
  }

  private deadline(now: number): number {
    const expiresAt = now + this.ttlMs
    if (!Number.isSafeInteger(expiresAt)) throw new ProtocolError('INVALID_MESSAGE')
    return expiresAt
  }
}
