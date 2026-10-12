import type { ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection/client'
import { DEFAULT_LIMITS, ProtocolError, checkJsonLength, type Command, type Json } from '../../../protocol/src/index.ts'
import { argsOf, fields, object, rpcFailure, text } from './read-routes.ts'
interface Delivery { deliveryId: string; eventId: string; event: string; request: Record<string, Json>; state: 'pending' | 'in-flight' | 'uncertain'; bytes: number }
export class NativeInteractions {
  private clientId = ''
  private readonly entries = new Map<string, Delivery>()
  private bytes = 0
  constructor(private readonly call: (command: Command, signal?: AbortSignal) => Promise<Json>) {}
  begin(host: Json) { this.entries.clear(); this.bytes = 0; this.clientId = crypto.randomUUID(); return { type: 'ready', clientId: this.clientId, host } }
  accept(value: Json): Json | undefined {
    const frame = object(value)
    if (frame.kind === 'dsh') return frame.value
    if (frame.kind === 'interaction-cancel') {
      const entry = [...this.entries.values()].find(e => e.deliveryId === frame.deliveryId)
      if (!entry) return
      this.drop(entry); return { type: 'cancel', eventId: entry.eventId }
    }
    if (frame.kind !== 'interaction' || !this.clientId || !['approval/request', 'user-questions/request'].includes(String(frame.event))) throw new ProtocolError('INVALID_MESSAGE')
    const json = JSON.stringify(value); checkJsonLength(json, DEFAULT_LIMITS.jsonBytes); const bytes = new TextEncoder().encode(json).byteLength
    if (this.entries.size >= 128 || this.bytes + bytes > DEFAULT_LIMITS.bufferedBytes) throw new ProtocolError('BACKPRESSURE')
    const deliveryId = text(frame.deliveryId)
    if ([...this.entries.values()].some(e => e.deliveryId === deliveryId)) throw new ProtocolError('INVALID_MESSAGE')
    const entry: Delivery = { deliveryId, eventId: crypto.randomUUID(), event: text(frame.event), request: object(frame.request), state: 'pending', bytes }
    this.entries.set(entry.eventId, entry); this.bytes += bytes
    return { type: 'waterfall', event: entry.event, eventId: entry.eventId, agentId: text(frame.sessionId), request: entry.request }
  }
  async answer(payload: unknown, signal: AbortSignal): Promise<ConnectionRpcResult<unknown>> {
    try {
      const args = argsOf('/api', payload); fields(args, ['clientId', 'eventId', 'outcome'])
      const entry = this.entries.get(text(args.eventId))
      if (args.clientId !== this.clientId || !entry) throw new ProtocolError('STALE_ACTION')
      if (entry.state !== 'pending') throw new ProtocolError(entry.state === 'uncertain' ? 'RESULT_UNCERTAIN' : 'STALE_ACTION')
      const outcome = object(args.outcome)
      let command: Command
      if (outcome.kind === 'next') { fields(outcome, ['kind']); command = { op: 'interaction.delegate', deliveryId: entry.deliveryId } }
      else if (outcome.kind === 'rejected') { fields(outcome, ['kind', 'error']); command = { op: 'interaction.delegate', deliveryId: entry.deliveryId } }
      else {
        fields(outcome, ['kind', 'value']); if (outcome.kind !== 'result') throw new ProtocolError('INVALID_MESSAGE')
        validateAnswer(entry, outcome.value); command = { op: 'interaction.answer', deliveryId: entry.deliveryId, answer: outcome.value }
      }
      signal.throwIfAborted(); entry.state = 'in-flight'
      try { const result = object(await this.call(command, signal)); if (result.accepted !== true) throw new ProtocolError('RESULT_UNCERTAIN'); this.drop(entry); return { ok: true, value: null } }
      catch (error) { if (this.entries.get(entry.eventId) === entry) { if (error instanceof ProtocolError && error.code === 'STALE_ACTION') this.drop(entry); else entry.state = 'uncertain' } throw error }
    } catch (error) { return rpcFailure(error) }
  }
  private drop(entry: Delivery): void { if (this.entries.delete(entry.eventId)) this.bytes -= entry.bytes }
  dispose(): void { this.clientId = ''; this.entries.clear(); this.bytes = 0 }
}
function validateAnswer(entry: Delivery, value: Json): void {
  const invalid = () => { throw new ProtocolError('INVALID_MESSAGE') }
  if (entry.event === 'approval/request') { if (value !== 'allowed-once' && value !== 'rejected') invalid(); return }
  const answer = object(value); fields(answer, ['answers']); const questions = entry.request.questions
  if (!Array.isArray(answer.answers) || !Array.isArray(questions) || answer.answers.length !== questions.length) return invalid()
  const ids = new Set<string>()
  for (const value of answer.answers) {
    const reply = object(value); fields(reply, ['id', 'selected'], ['custom']); const id = text(reply.id)
    const question = questions.map(object).find(q => q.id === id)
    if (!question || ids.has(id) || !Array.isArray(reply.selected) || new Set(reply.selected).size !== reply.selected.length) return invalid()
    ids.add(id)
    const options = Array.isArray(question.options) ? question.options.map(o => object(o).label) : []
    if (reply.selected.some(o => typeof o !== 'string' || !options.includes(o)) || (question.multiSelect !== true && reply.selected.length > 1)) invalid()
    if ('custom' in reply && typeof reply.custom !== 'string') invalid()
    if (!reply.selected.length && (typeof reply.custom !== 'string' || !reply.custom.trim())) invalid()
    if (question.multiSelect !== true && reply.selected.length && reply.custom !== undefined && reply.custom !== '') invalid()
  }
}
