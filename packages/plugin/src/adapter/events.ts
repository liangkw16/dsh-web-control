import { randomUUID } from 'node:crypto'
import { ProtocolError } from '../../../protocol/src/index.ts'
import { opaqueId } from './scope.ts'
/** Host-issued single-use correlation; browsers never supply native event identities. */
export class EventLedger {
  private readonly deliveries = new Map<string, { clientId: string; eventId: string }>()
  record(clientId: string, eventId: string): string {
    opaqueId(clientId); opaqueId(eventId)
    if (this.deliveries.size >= 128) throw new ProtocolError('BACKPRESSURE')
    const deliveryId = randomUUID(); this.deliveries.set(deliveryId, { clientId, eventId }); return deliveryId
  }
  take(deliveryId: string): { clientId: string; eventId: string } | undefined {
    const value = this.deliveries.get(deliveryId); this.deliveries.delete(deliveryId); return value
  }
  cancel(eventId: string): string | undefined {
    for (const [id, value] of this.deliveries) if (value.eventId === eventId) { this.deliveries.delete(id); return id }
  }
  clear(): void { this.deliveries.clear() }
}
