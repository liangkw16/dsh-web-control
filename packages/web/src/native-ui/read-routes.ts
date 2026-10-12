import type { ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection/client'
import { DEFAULT_LIMITS, ProtocolError, checkJsonLength, integer, parseUiReadResult, validateJson, type Json, type Watch } from '../../../protocol/src/index.ts'
import type { BrowserTransport } from '../transport.ts'
export type ReadTransport = Pick<BrowserTransport, 'call' | 'watch'>
export function rpcFailure(error: unknown): ConnectionRpcResult<never> {
  const code = error instanceof ProtocolError ? error.code : 'RESULT_UNCERTAIN'
  return { ok: false, error: { code, message: code, details: {} } }
}
/** Original Remote uses null-prototype argument maps. Copy only own data fields, never getters. */
export function nativeJson(value: unknown, maxBytes = DEFAULT_LIMITS.jsonBytes): Json {
  let nodes = 0
  const copy = (v: unknown, depth: number): Json => {
    if (++nodes > 32768 || depth > 64) throw new ProtocolError('INVALID_MESSAGE')
    if (v === null || typeof v !== 'object') return validateJson(v)
    const proto = Object.getPrototypeOf(v)
    if (Array.isArray(v)) {
      if (proto !== Array.prototype || Reflect.ownKeys(v).length !== v.length + 1) throw new ProtocolError('INVALID_MESSAGE')
      return Array.from({ length: v.length }, (_, i) => field(v, String(i), depth))
    }
    if (proto !== null && proto !== Object.prototype) throw new ProtocolError('INVALID_MESSAGE')
    const out: Record<string, Json> = {}
    for (const key of Reflect.ownKeys(v)) {
      if (typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key)) throw new ProtocolError('INVALID_MESSAGE')
      out[key] = field(v, key, depth)
    }
    return out
  }
  const field = (v: object, key: string, depth: number): Json => {
    const d = Object.getOwnPropertyDescriptor(v, key)
    if (!d || !d.enumerable || !Object.hasOwn(d, 'value')) throw new ProtocolError('INVALID_MESSAGE')
    return copy(d.value, depth + 1)
  }
  const result = copy(value, 0); validateJson(result); checkJsonLength(JSON.stringify(result), maxBytes); return result
}
export function object(value: unknown): Record<string, Json> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProtocolError('INVALID_MESSAGE')
  return value as Record<string, Json>
}
export function fields(value: Record<string, Json>, required: string[], optional: string[] = []): void {
  if (required.some(k => !Object.hasOwn(value, k)) || Object.keys(value).some(k => !required.includes(k) && !optional.includes(k))) throw new ProtocolError('INVALID_MESSAGE')
}
export function text(value: unknown): string { if (typeof value !== 'string' || !value || value.length > 4096) throw new ProtocolError('INVALID_MESSAGE'); return value }
export function argsOf(channel: string, payload: unknown, maxBytes?: number): Record<string, Json> {
  if (channel !== '/api') throw new ProtocolError('PROTOCOL_UNSUPPORTED')
  const outer = object(nativeJson(payload, maxBytes)); fields(outer, ['args']); return object(outer.args)
}
export function historyRequest(args: Record<string, Json>, page: boolean) {
  fields(args, ['request']); const request = object(args.request)
  fields(request, page ? ['address', 'throughSeq'] : ['address'], page ? ['beforeSeq', 'maxMessages', 'turnWindow'] : ['maxMessages', 'turnWindow', 'assistantStream'])
  const address = object(request.address); fields(address, ['kind', 'sessionId'])
  if (address.kind !== 'session') throw new ProtocolError('OUT_OF_SCOPE')
  const sessionId = text(address.sessionId), maxMessages = request.maxMessages ?? 64; integer(maxMessages, 1)
  if ('assistantStream' in request && request.assistantStream !== true) throw new ProtocolError('INVALID_MESSAGE')
  if (page) { integer(request.throughSeq); if ('beforeSeq' in request) integer(request.beforeSeq) }
  let turnWindow: { minMessages: number; minTurns: number } | undefined
  if ('turnWindow' in request) {
    const window = object(request.turnWindow); fields(window, ['minMessages', 'minTurns']); integer(window.minMessages, 0, maxMessages); integer(window.minTurns)
    turnWindow = { minMessages: window.minMessages, minTurns: window.minTurns }
  }
  return { sessionId, maxMessages, turnWindow, throughSeq: request.throughSeq as number, beforeSeq: request.beforeSeq as number | undefined }
}
async function workspaceIds(transport: ReadTransport, signal: AbortSignal): Promise<string[]> {
  const controller = new AbortController(), linked = AbortSignal.any([signal, controller.signal])
  const iterator = transport.watch({ topic: 'workspaces' }, linked)[Symbol.asyncIterator]()
  try {
    const first = await iterator.next(); signal.throwIfAborted()
    if (first.done) throw new ProtocolError('RESYNC_REQUIRED')
    const event = object(first.value), frame = object(event.value), value = object(frame.value)
    if (event.kind !== 'dsh' || frame.type !== 'baseline' || !Array.isArray(value.items)) throw new ProtocolError('RESYNC_REQUIRED')
    return [...new Set(value.items.map(item => text(object(item).workspaceId)))]
  } finally { controller.abort(); await iterator.return?.() }
}
export async function dispatchRead(transport: ReadTransport, channel: string, endpoint: string, payload: unknown, signal: AbortSignal, profileCatalog = false): Promise<ConnectionRpcResult<unknown>> {
  try {
    const args = argsOf(channel, payload); signal.throwIfAborted()
    if (endpoint === 'session/search' && profileCatalog) {
      fields(args, ['request']); const request = object(args.request); fields(request, ['query'])
      const value = object(await transport.call({ op: 'ui.search', query: text(request.query) }, signal)); signal.throwIfAborted()
      fields(value, ['items', 'hasMore']); if (!Array.isArray(value.items) || typeof value.hasMore !== 'boolean') throw new ProtocolError('INVALID_MESSAGE')
      return { ok: true, value }
    }
    if (endpoint === 'session/page') {
      const r = historyRequest(args, true)
      const value = await transport.call({ op: 'session.page', sessionId: r.sessionId, throughSeq: r.throughSeq, maxMessages: r.maxMessages, ...(r.beforeSeq === undefined ? {} : { beforeSeq: r.beforeSeq }), ...(r.turnWindow ? { turnWindow: r.turnWindow } : {}) }, signal)
      signal.throwIfAborted(); return { ok: true, value }
    }
    if (endpoint === 'session/list') {
      fields(args, ['_request']); fields(object(args._request), [])
      if (profileCatalog) {
        const value = object(await transport.call({ op: 'ui.catalog' }, signal)); signal.throwIfAborted()
        fields(value, ['items']); if (!Array.isArray(value.items)) throw new ProtocolError('INVALID_MESSAGE')
        return { ok: true, value }
      }
      const ids = await workspaceIds(transport, signal), items = new Map<string, Json>()
      for (const workspaceId of ids) {
        const value = object(await transport.call({ op: 'session.list', workspaceId }, signal)); signal.throwIfAborted()
        fields(value, ['items']); if (!Array.isArray(value.items)) throw new ProtocolError('INVALID_MESSAGE')
        for (const item of value.items) items.set(text(object(item).sessionId), item)
      }
      return { ok: true, value: { items: [...items.values()] } }
    }
    throw new ProtocolError('PROTOCOL_UNSUPPORTED')
  } catch (error) { return rpcFailure(error) }
}
export function readWatch(channel: string, endpoint: string, payload: unknown): Watch {
  const args = argsOf(channel, payload)
  if (endpoint === 'session/follow') {
    const r = historyRequest(args, false)
    return { topic: 'session', sessionId: r.sessionId, maxMessages: r.maxMessages, ...(r.turnWindow ? { turnWindow: r.turnWindow } : {}) }
  }
  fields(args, [])
  if (endpoint === 'workspace/follow') return { topic: 'workspaces' }
  if (endpoint === 'session/control') return { topic: 'sessions' }
  throw new ProtocolError('PROTOCOL_UNSUPPORTED')
}
export async function* openRead(transport: ReadTransport, channel: string, endpoint: string, payload: unknown, signal: AbortSignal): AsyncIterable<unknown> {
  const watch = readWatch(channel, endpoint, payload)
  for await (const value of transport.watch(watch, signal)) {
    signal.throwIfAborted(); const frame = object(value)
    if (frame.kind === 'dsh') {
      const native = object(frame.value)
      yield watch.topic === 'session' && native.type === 'snapshot' ? await completeOpeningTurn(transport, watch.sessionId, native, signal) : native
    }
    else if (frame.kind !== 'stop-token') throw new ProtocolError('INVALID_MESSAGE')
  }
}
/** Wire snapshots are deliberately small. Complete a clipped visible turn through
 * the existing paged API so stock duration/usage/artifact projections see their
 * real lifecycle, without increasing wire limits or inventing metadata. */
async function completeOpeningTurn(transport: ReadTransport, sessionId: string, opening: Record<string, Json>, signal: AbortSignal): Promise<Json> {
  if (!opening.hasMore || !Array.isArray(opening.records) || !opening.records.length) return opening
  const eventOf = (record: Json) => object(object(record).event)
  const turnOf = (record: Json) => {
    const data = eventOf(record).data
    return data && typeof data === 'object' && !Array.isArray(data) ? data.turn : undefined
  }
  const first = opening.records.find(record => Number.isSafeInteger(turnOf(record)) && (turnOf(record) as number) > 0)
  if (!first) return opening
  const turn = turnOf(first)
  const hasStart = (records: Json[]) => records.some(record => eventOf(record).type === 'turn/start' && turnOf(record) === turn)
  if (hasStart(opening.records)) return opening
  const encodedSize = (records: Json[]) => new TextEncoder().encode(JSON.stringify(records)).byteLength
  let records = opening.records, hasMore: boolean = opening.hasMore === true, bytes = encodedSize(records)
  // Bound local aggregation as well as individual wire frames. Extremely large
  // turns retain the stock Load earlier affordance instead of stalling startup.
  for (let page = 0; page < 16 && hasMore && bytes < 2 * 1024 * 1024; page++) {
    signal.throwIfAborted()
    const beforeSeq = eventOf(records[0]).seq
    integer(beforeSeq); integer(opening.cursor)
    let value: Record<string, Json>
    try { value = object(await transport.call({ op: 'session.page', sessionId, throughSeq: opening.cursor as number, beforeSeq: beforeSeq as number, maxMessages: 64 }, signal)) }
    catch { signal.throwIfAborted(); break } // Supplemental history must not break an otherwise usable connection.
    signal.throwIfAborted()
    if (!Array.isArray(value.records) || !value.records.length || typeof value.hasMore !== 'boolean') break
    let previous = -1
    for (const record of value.records) {
      const seq = eventOf(record).seq; integer(seq)
      if ((seq as number) <= previous || (seq as number) >= (beforeSeq as number)) throw new ProtocolError('INVALID_MESSAGE')
      previous = seq as number
    }
    const extra = encodedSize(value.records)
    if (bytes + extra > 2 * 1024 * 1024) break
    bytes += extra; records = [...value.records, ...records]; hasMore = value.hasMore
    if (hasStart(value.records)) break
  }
  return { ...opening, records, hasMore }
}
export async function readHostFacts(transport: ReadTransport, signal: AbortSignal): Promise<Json> {
  return parseUiReadResult('host-facts', await transport.call({ op: 'ui.read', view: 'host-facts' }, signal))
}
