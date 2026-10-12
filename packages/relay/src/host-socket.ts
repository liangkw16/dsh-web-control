import { randomUUID } from 'node:crypto'
import {
  ProtocolError,
  type Fence,
  type HostUiProfile,
  type HandshakeMessage,
  type Limits,
} from '@dsh-web-control/protocol'
import { ATTACH_MS } from './config.ts'
import type { Transport, TransportGroup } from './transport.ts'
export const sameFence = (a: Fence, b: Fence) =>
  a.instanceId === b.instanceId &&
  a.runtimeId === b.runtimeId &&
  a.authEpoch === b.authEpoch &&
  a.controlId === b.controlId
/** Relay-side Host channel. Host owns HostFence and handles detach by invalidating observers,
 * never by cancelling accepted Agent work. All ACKs bind the complete Fence and correlation. */
export class HostSocket {
  private pending?: {
    id: string
    fence: Fence
    resolve: () => void
    reject: (e: Error) => void
    timer: NodeJS.Timeout
  }
  constructor(
    readonly instanceId: string,
    readonly runtimeId: string,
    readonly socketId: string,
    public authEpoch: number,
    readonly limits: Limits,
    readonly transport: Transport,
    readonly group: TransportGroup,
    readonly current: () => void,
    readonly uiProfile: HostUiProfile | null = null,
  ) {}
  attach(fence: Fence, leaseId: string): Promise<void> {
    this.current()
    if (this.pending) throw new ProtocolError('REMOTE_BUSY')
    return new Promise((resolve, reject) => {
      const id = randomUUID(),
        timer = setTimeout(() => this.abort('HOST_OFFLINE'), ATTACH_MS)
      this.pending = { id, fence, resolve, reject, timer }
      try {
        this.transport.send(
          { v: 1, type: 'attach', id, leaseId, fence },
          () => {
            this.current()
            if (this.pending?.id !== id)
              throw new ProtocolError('STALE_CONTROL')
          },
        )
      } catch (error) {
        this.abort('RESYNC_REQUIRED')
      }
    })
  }
  attached(
    message: Extract<HandshakeMessage, { type: 'host.attached' }>,
  ): void {
    this.current()
    const pending = this.pending
    // Late ACK from a disposed attempt cannot install a new browser generation.
    if (!pending || message.id !== pending.id) return
    if (!sameFence(message.fence, pending.fence)) {
      this.abort('STALE_CONTROL')
      return
    }
    clearTimeout(pending.timer)
    this.pending = undefined
    pending.resolve()
  }
  detach(fence: Fence): void {
    if (this.pending && sameFence(this.pending.fence, fence))
      this.abort('STALE_CONTROL')
    try {
      this.transport.send({ v: 1, type: 'detach', fence })
    } catch {}
  }
  abort(code: string): void {
    const p = this.pending
    if (p) {
      clearTimeout(p.timer)
      this.pending = undefined
      p.reject(new ProtocolError(code))
    }
  }
}
