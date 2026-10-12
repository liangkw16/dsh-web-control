import { randomUUID } from 'node:crypto'
import { ProtocolError, type Json } from '../../../protocol/src/index.ts'
interface Turn { agent: object; turnStartSeq: number }
interface Issued extends Turn { token: string; consumed: boolean }
/** Process-local capabilities for one exact Agent and one open turn. */
export class StopTokens {
  private readonly issued = new Map<string, Issued>()
  constructor(private readonly read: (id: string) => Turn | null, private readonly cancel: (id: string) => Json) {}
  current(id: string): string | null {
    const current = this.read(id)
    if (!current) { this.issued.delete(id); return null }
    const issued = this.issued.get(id)
    if (issued && issued.agent === current.agent && issued.turnStartSeq === current.turnStartSeq) return issued.consumed ? null : issued.token
    const next = { ...current, token: randomUUID(), consumed: false }
    this.issued.set(id, next)
    return next.token
  }
  stop(id: string, token: string): Json {
    const current = this.read(id); const issued = this.issued.get(id)
    if (!current || !issued || issued.consumed || issued.token !== token || current.agent !== issued.agent || current.turnStartSeq !== issued.turnStartSeq) throw new ProtocolError('STALE_ACTION')
    // Consume before cancel even when the public call fails: never retry an uncertain stop.
    issued.consumed = true
    return this.cancel(id)
  }
}
