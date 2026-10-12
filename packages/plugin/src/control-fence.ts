import { ProtocolError, validateFence, validateId, type Fence } from '../../protocol/src/index.ts'
import { validateIdentity, type Identity } from './identity.ts'

function same(left: Fence, right: Fence): boolean {
  return left.instanceId === right.instanceId && left.runtimeId === right.runtimeId
    && left.controlId === right.controlId && left.authEpoch === right.authEpoch
}

/** Admission only: check again after awaits immediately before dispatch.
 * signal scopes observers/transfers to the installed generation, never accepted Agent work.
 * Install completes synchronously before the caller sends host.attached; only the relay's
 * matching ACK exchange can make a browser ready. Disconnect/disposal must invalidate.
 */
export class HostFence {
  private current: Fence | undefined
  private lifetime = new AbortController()

  constructor(private instanceId: string, private runtimeId: string, private readonly getIdentity: () => Identity) {
    validateId(instanceId); validateId(runtimeId)
    this.lifetime.abort()
  }

  /** Local owner transition only. Existing captured admissions remain permanently stale. */
  rebind(instanceId: string, runtimeId: string): void {
    validateId(instanceId); validateId(runtimeId)
    this.invalidate(); this.instanceId = instanceId; this.runtimeId = runtimeId
  }

  get signal(): AbortSignal { return this.lifetime.signal }

  install(fence: Fence): void {
    validateFence(fence)
    this.authorize(fence)
    this.scope(fence)
    if (this.current && same(this.current, fence)) return
    this.invalidate()
    this.current = { ...fence }
    this.lifetime = new AbortController()
  }

  check(fence: Fence): void {
    validateFence(fence)
    this.authorize(fence)
    this.scope(fence)
    if (!this.current || !same(this.current, fence)) throw new ProtocolError('STALE_CONTROL')
  }

  invalidate(): void {
    this.current = undefined
    this.lifetime.abort()
  }

  private authorize(fence: Fence): void {
    let identity: Identity
    try { identity = validateIdentity(this.getIdentity()) } catch (error) { this.invalidate(); throw error }
    if (identity.instanceId !== this.instanceId || !identity.enabled) {
      this.invalidate()
      throw new ProtocolError('AUTH_REVOKED')
    }
    // Rotation invalidates the old observer/transfer generation even when the incoming
    // message already names the new epoch. A fresh attach is still required.
    if (this.current && this.current.authEpoch !== identity.authEpoch) this.invalidate()
    // A stale incoming epoch must not invalidate a healthy, newer controller.
    if (fence.authEpoch !== identity.authEpoch) throw new ProtocolError('AUTH_REVOKED')
  }

  private scope(fence: Fence): void {
    if (fence.instanceId !== this.instanceId || fence.runtimeId !== this.runtimeId) throw new ProtocolError('STALE_CONTROL')
  }
}
