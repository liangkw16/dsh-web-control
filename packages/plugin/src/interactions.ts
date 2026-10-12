import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { parseRemoteEventResult, type RemoteEventResult } from '@deepseek-ai/dsh-api-gateway/stream-protocol'
import { DEFAULT_LIMITS, ProtocolError, validateJson, type Fence, type Json } from '../../protocol/src/index.ts'
import { EventLedger } from './adapter/events.ts'
import { fields, invalid, jsonObject, text, publicJson } from './adapter/dsh-v021.ts'
import type { HostFence } from './control-fence.ts'
import type { StreamValue } from './streams.ts'
export type EventSource = (signal: AbortSignal) => AsyncIterable<unknown> | Promise<AsyncIterable<unknown>>
export function authenticatedEvents(ctx: Context): EventSource {
  return signal => ctx.typertGateway.wireStream.open('$events', { args: {} }, (async function* () {})(), undefined, signal)
}
/** Only the authenticated in-process Connection can submit native result envelopes. */
export function sharedEventReply(sharedFetch: (request: Request) => Promise<Response>): (result: RemoteEventResult) => Promise<void> {
  return async result => {
    const rpcId = randomUUID()
    const response = await sharedFetch(new Request('http://dsh.internal/api/$events/result', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId, method: '$events/result', payload: { args: result } }) }))
    const envelope = jsonObject(validateJson(await response.json()))
    const outcome = jsonObject(envelope.result)
    if (!response.ok || envelope.type !== 'server-response' || envelope.rpcId !== rpcId || outcome.ok !== true) throw new ProtocolError('RESULT_UNCERTAIN')
  }
}
interface Pending { event: string; request: Json; sessionId: string; bytes: number; release: () => void }
export class InteractionBridge {
  private readonly ledger = new EventLedger()
  private readonly pending = new Map<string, Pending>()
  private readonly lifetime = new AbortController()
  private pendingBytes = 0
  private acquisition?: Promise<AsyncIterable<unknown>>
  private iterator?: AsyncIterator<unknown>
  private opened = false
  private readonly incoming: Fence
  constructor(incoming: Fence, private readonly fence: HostFence, private readonly source: EventSource,
    private readonly assertSession: (id: string) => void, private readonly reply: (result: RemoteEventResult) => Promise<void>, private readonly reserve: (bytes: number) => () => void = () => () => {}) { this.incoming = Object.freeze({ ...incoming }) }
  /** Final scope admission must be synchronous, as with SessionScope.assertSession. */
  private currentScope(id: string): void {
    const value = this.assertSession(id)
    if (value !== undefined) { void Promise.resolve(value).catch(() => {}); throw new ProtocolError('PROTOCOL_UNSUPPORTED', 'A synchronous current scope checker is required') }
  }
  private check(): void { this.fence.check(this.incoming); this.lifetime.signal.throwIfAborted() }
  async *open(signal: AbortSignal): AsyncIterable<StreamValue> {
    if (this.opened) throw new ProtocolError('STALE_CONTROL'); this.opened = true
    const linked = AbortSignal.any([signal, this.fence.signal, this.lifetime.signal]); let clientId: string | undefined
    try {
      this.check(); linked.throwIfAborted()
      this.acquisition = Promise.resolve(this.source(linked))
      this.iterator = (await this.acquisition)[Symbol.asyncIterator](); this.check(); linked.throwIfAborted()
      while (true) {
        const next = await this.iterator.next(); this.check(); linked.throwIfAborted(); if (next.done) break
        const frame = jsonObject(eventHeader(next.value))
        if (!clientId) { fields(frame, ['type', 'clientId', 'host']); if (frame.type !== 'ready') invalid(); const host = jsonObject(frame.host); fields(host, ['home']); if (typeof host.home !== 'string') invalid(); text(frame.clientId); clientId = frame.clientId; yield { kind: 'interactions-ready' }; continue }
        if (frame.type === 'waterfall') {
          fields(frame, ['type', 'event', 'eventId', 'agentId', 'request'])
          text(frame.eventId); text(frame.event); text(frame.agentId)
          let scoped = true
          try { await this.assertSession(frame.agentId) } catch (error) { if (outOfScope(error)) scoped = false; else throw error }
          this.check(); linked.throwIfAborted()
          if (scoped) { try { this.currentScope(frame.agentId) } catch (error) { if (outOfScope(error)) scoped = false; else throw error } }
          this.check(); linked.throwIfAborted()
          const supported = frame.event === 'approval/request' || frame.event === 'user-questions/request'
          const request = scoped && supported ? interactionRequest(frame.event, jsonObject(publicJson(next.value)).request) : undefined
          if (!scoped || !request) {
            this.check(); linked.throwIfAborted()
            await this.reply(parseRemoteEventResult({ clientId, eventId: frame.eventId, outcome: { kind: 'next' } })); this.check(); continue
          }
          const bytes = Buffer.byteLength(JSON.stringify(request))
          if (this.pendingBytes + bytes > DEFAULT_LIMITS.bufferedBytes) throw new ProtocolError('BACKPRESSURE')
          const release = this.reserve(bytes + 128)
          let deliveryId: string
          try { deliveryId = this.ledger.record(clientId, frame.eventId) } catch (error) { release(); throw error }
          this.pending.set(deliveryId, { event: frame.event, request, sessionId: frame.agentId, bytes, release })
          this.pendingBytes += bytes
          yield { kind: 'interaction', sessionId: frame.agentId, deliveryId, event: frame.event, request }
        } else if (frame.type === 'cancel') {
          fields(frame, ['type', 'eventId'])
          text(frame.eventId); const deliveryId = this.ledger.cancel(frame.eventId)
          if (deliveryId) { this.pendingBytes -= this.pending.get(deliveryId)?.bytes ?? 0; this.pending.get(deliveryId)?.release(); this.pending.delete(deliveryId); yield { kind: 'interaction-cancel', deliveryId } }
        } else if (frame.type === 'emit') {
          fields(frame, ['type', 'event', 'args'])
          // Only the fixed Session notification vocabulary has a known scope address.
          text(frame.event)
          if (!['api-session/added', 'api-session/removed', 'api-session/activity', 'api-session/error', 'api-session/status'].includes(frame.event)) continue
          const args = jsonObject(publicJson(next.value)).args
          if (!Array.isArray(args)) invalid()
          const first = args[0]; const id = typeof first === 'string' ? first : jsonObject(first).sessionId
          text(id)
          try { await this.assertSession(id) } catch (error) { if (outOfScope(error)) continue; throw error }
          this.currentScope(id); this.check(); linked.throwIfAborted(); yield { kind: 'dsh', value: { type: 'emit', event: frame.event, args } }
        } else invalid()
      }
    } finally { this.lifetime.abort(); this.ledger.clear(); for (const pending of this.pending.values()) pending.release(); this.pending.clear(); this.pendingBytes = 0; await this.iterator?.return?.() }
  }
  assertDelivery(deliveryId: string): void {
    this.check(); const pending = this.pending.get(deliveryId); if (!pending) throw new ProtocolError('STALE_ACTION')
    this.currentScope(pending.sessionId); this.check()
  }
  /** A workspace observer calls this even when the event stream is quiet. */
  async scopeChanged(): Promise<StreamValue[]> {
    const values: StreamValue[] = []; this.check()
    for (const [deliveryId, pending] of this.pending) {
      try { await this.assertSession(pending.sessionId); this.check(); this.currentScope(pending.sessionId); this.check() }
      catch (error) {
        if (!outOfScope(error)) throw error
        this.check()
        const identity = this.ledger.take(deliveryId)
        if (!identity) continue
        this.pending.delete(deliveryId); pending.release(); this.pendingBytes -= pending.bytes
        this.check(); await this.reply(parseRemoteEventResult({ ...identity, outcome: { kind: 'next' } })); this.check()
        values.push({ kind: 'interaction-cancel', deliveryId })
      }
    }
    return values
  }
  async answer(deliveryId: string, answer: Json, signal?: AbortSignal): Promise<Json> {
    signal?.throwIfAborted()
    this.check(); const pending = this.pending.get(deliveryId)
    if (!pending) throw new ProtocolError('STALE_ACTION')
    const verified = publicJson(validateJson(answer))
    validateAnswer(pending, verified) // Preserve pending capability on invalid input.
    await this.assertSession(pending.sessionId)
    this.check(); this.currentScope(pending.sessionId); this.check()
    signal?.throwIfAborted()
    // No await between last authority check, single-use consume and actual native mutation.
    const identity = this.ledger.take(deliveryId)
    if (!identity) throw new ProtocolError('STALE_ACTION')
    this.pending.delete(deliveryId); pending.release(); this.pendingBytes -= pending.bytes
    const result = parseRemoteEventResult({ ...identity, outcome: { kind: 'result', value: verified } })
    this.check(); await this.reply(result); this.check()
    return { accepted: true }
  }
  /** Release this browser's delivery to the existing Host continuation, without an answer. */
  async delegate(deliveryId: string, signal?: AbortSignal): Promise<Json> {
    signal?.throwIfAborted()
    this.assertDelivery(deliveryId)
    const pending = this.pending.get(deliveryId)!
    await this.assertSession(pending.sessionId)
    this.check(); this.currentScope(pending.sessionId); this.check()
    signal?.throwIfAborted()
    const identity = this.ledger.take(deliveryId)
    if (!identity) throw new ProtocolError('STALE_ACTION')
    this.pending.delete(deliveryId); pending.release(); this.pendingBytes -= pending.bytes
    await this.reply(parseRemoteEventResult({ ...identity, outcome: { kind: 'next' } })); this.check()
    return { accepted: true }
  }
  async dispose(): Promise<void> {
    this.lifetime.abort(); this.ledger.clear(); for (const pending of this.pending.values()) pending.release(); this.pending.clear(); this.pendingBytes = 0
    try { await this.acquisition } catch {}
    await this.iterator?.return?.()
  }
}
function interactionRequest(event: string, value: Json | undefined): Json | undefined {
  if (event !== 'approval/request' && event !== 'user-questions/request') return
  const request = jsonObject(value)
  if (event === 'approval/request') {
    fields(request, ['toolName', 'callId', 'reason', 'displayReason']); text(request.toolName)
    for (const key of ['callId', 'reason']) if (request[key] !== undefined && typeof request[key] !== 'string') invalid()
    if (request.displayReason !== undefined) { const display = jsonObject(request.displayReason); text(display.en); if (Object.values(display).some(item => typeof item !== 'string')) invalid() }
  } else {
    fields(request, ['questions', 'wait']); if (!Array.isArray(request.questions) || !request.questions.length) invalid()
    const ids = new Set<string>()
    for (const item of request.questions) {
      const question = jsonObject(item); fields(question, ['id', 'question', 'detail', 'header', 'options', 'multiSelect', 'intent']); text(question.id); text(question.question)
      if (ids.has(question.id)) invalid(); ids.add(question.id)
      for (const key of ['detail', 'header']) if (question[key] !== undefined && typeof question[key] !== 'string') invalid()
      if (question.multiSelect !== undefined && typeof question.multiSelect !== 'boolean') invalid()
      if (question.options !== undefined) { if (!Array.isArray(question.options)) invalid(); const labels = new Set<string>(); for (const item of question.options) { const option = jsonObject(item); fields(option, ['label', 'description']); text(option.label); if (labels.has(option.label)) invalid(); labels.add(option.label); if (option.description !== undefined && typeof option.description !== 'string') invalid() } }
      if (question.intent !== undefined) { const intent = jsonObject(question.intent); fields(intent, ['kind', 'approve', 'callId']); if (intent.kind !== 'plan-review') invalid(); text(intent.approve); if (!Array.isArray(question.options) || !question.options.some(option => jsonObject(option).label === intent.approve)) invalid(); if (intent.callId !== undefined) text(intent.callId) }
    }
    if (request.wait !== undefined) { const wait = jsonObject(request.wait); fields(wait, ['callId', 'timed']); text(wait.callId); if (wait.timed !== undefined && wait.timed !== true) invalid() }
  }
  return request
}
function validateAnswer(pending: Pending, value: Json): void {
  if (pending.event === 'approval/request') { if (value !== 'allowed-once' && value !== 'rejected') invalid(); return }
  const answer = jsonObject(value); fields(answer, ['answers']); const request = jsonObject(pending.request)
  if (!Array.isArray(answer.answers) || !Array.isArray(request.questions) || answer.answers.length !== request.questions.length) invalid()
  const ids = new Set<string>()
  for (const item of answer.answers) {
    const reply = jsonObject(item); fields(reply, ['id', 'selected', 'custom']); text(reply.id)
    if (ids.has(reply.id)) invalid(); ids.add(reply.id)
    const question = request.questions.map(jsonObject).find(q => q.id === reply.id)
    if (!question || !Array.isArray(reply.selected) || reply.selected.some(label => typeof label !== 'string') || new Set(reply.selected).size !== reply.selected.length) invalid()
    if (question.multiSelect !== true && reply.selected.length > 1) invalid()
    const options = Array.isArray(question.options) ? question.options.map(jsonObject).map(option => option.label) : []
    if (reply.selected.some(label => !options.includes(label))) invalid()
    if (reply.custom !== undefined && typeof reply.custom !== 'string') invalid()
    if (!reply.selected.length && (typeof reply.custom !== 'string' || !reply.custom.trim())) invalid()
    if (question.multiSelect !== true && reply.selected.length && reply.custom !== undefined && reply.custom !== '') invalid()
  }
}

function outOfScope(error: unknown): boolean { return error instanceof ProtocolError ? error.code === 'OUT_OF_SCOPE' : error instanceof Error && error.message === 'OUT_OF_SCOPE' }

/** Unforwarded native waterfall/notification payloads need no serialization.
 * Inspect bounded transport headers through own data descriptors first.
 */
function eventHeader(value: unknown): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
  const prototype = Object.getPrototypeOf(value); if (prototype !== Object.prototype && prototype !== null) invalid()
  const type = Object.getOwnPropertyDescriptor(value, 'type')
  if (!type?.enumerable || !Object.hasOwn(type, 'value')) invalid()
  if (type.value !== 'waterfall' && type.value !== 'emit') return publicJson(value)
  const allowed = type.value === 'waterfall' ? ['type', 'event', 'eventId', 'agentId', 'request'] : ['type', 'event', 'args']
  const entries: [string, unknown][] = []
  const keys = Reflect.ownKeys(value); if (keys.length !== allowed.length) invalid()
  for (const key of keys) {
    if (typeof key !== 'string' || !allowed.includes(key)) invalid()
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) invalid()
    entries.push([key, key === 'request' ? null : key === 'args' ? [] : descriptor.value])
  }
  return publicJson(Object.fromEntries(entries))
}
