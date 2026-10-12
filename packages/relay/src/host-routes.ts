import { ProtocolError, validateId } from '@dsh-web-control/protocol'

export interface HostRoute { runtimeId: string; socketId: string }

/** One authenticated live Host socket per instance, without implicit takeover or timeout.
 * The socket owner must confirm death before remove; server disposal calls clear.
 */
export class HostRoutes {
  private readonly routes = new Map<string, HostRoute>()

  claim(instanceId: string, runtimeId: string, socketId: string): void {
    validateId(instanceId); validateId(runtimeId); validateId(socketId)
    const current = this.routes.get(instanceId)
    if (current) {
      if (current.runtimeId !== runtimeId || current.socketId !== socketId) throw new ProtocolError('HOST_ID_IN_USE')
      return
    }
    this.routes.set(instanceId, { runtimeId, socketId })
  }

  remove(instanceId: string, socketId: string): void {
    validateId(instanceId); validateId(socketId)
    if (this.routes.get(instanceId)?.socketId === socketId) this.routes.delete(instanceId)
  }

  get(instanceId: string): HostRoute | undefined {
    validateId(instanceId)
    const current = this.routes.get(instanceId)
    return current && { ...current }
  }

  clear(): void { this.routes.clear() }
}
