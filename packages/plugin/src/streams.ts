import type { Context } from '@deepseek-ai/cordis'
import { DEFAULT_LIMITS, checkJsonLength, ProtocolError, type Fence, type Json, type Watch } from '../../protocol/src/index.ts'
import { fields, integer, invalid, jsonObject, projectionBaseline, text, publicJson, validateFollowFrame, SESSION_JSON_BYTES } from './adapter/dsh-v021.ts'
import type { SessionScope } from './adapter/scope.ts'
import type { SessionAdapter } from './adapter/types.ts'
import type { HostFence } from './control-fence.ts'
import type { InteractionBridge } from './interactions.ts'
export type StreamValue = { kind: 'dsh'; value: Json } | { kind: 'stop-token'; sessionId: string; token: string | null } | { kind: 'interactions-ready' } | { kind: 'interaction'; sessionId: string; deliveryId: string; event: string; request: Json } | { kind: 'interaction-cancel'; deliveryId: string }
/** Bounded one-consumer producer queue, stopped by the query's own lifetime. */
class ObserverQueue {
  private items: { value: StreamValue; bytes: number; generation?: number; release: () => void }[] = []; private bytes = 0; private wake?: () => void; private ended = false; private error?: unknown
  constructor(private readonly reserve: (bytes: number) => () => void, private readonly jsonBytes: number) {}
  clear(): void { for (const item of this.items) item.release(); this.items = []; this.bytes = 0 }
  push(value: StreamValue, generation?: number): void { if (this.ended) return; if (this.items.length >= 128) throw new ProtocolError('BACKPRESSURE'); const encoded = JSON.stringify(value); checkJsonLength(encoded, this.jsonBytes); const bytes = Buffer.byteLength(encoded); if (this.bytes + bytes > DEFAULT_LIMITS.bufferedBytes) throw new ProtocolError('BACKPRESSURE'); const release = this.reserve(bytes + 128); this.bytes += bytes; this.items.push({ value, bytes, generation, release }); this.wake?.() }
  discardControl(): void { this.items = this.items.filter(item => { if (item.generation === undefined) return true; this.bytes -= item.bytes; item.release(); return false }) }
  end(error?: unknown): void { this.ended = true; this.error = error; if (error) this.clear(); this.wake?.() }
  async next(): Promise<IteratorResult<{ value: StreamValue; generation?: number; release: () => void }>> {
    while (!this.items.length && !this.ended) await new Promise<void>(resolve => { this.wake = resolve })
    if (this.error) throw this.error
    const item = this.items.shift(); if (item) this.bytes -= item.bytes; return item ? { value: item, done: false } : { value: undefined, done: true }
  }
}
/** Public follow openings are forwarded intact; browser pages use that opening cursor. */
export class LiveStreams {
  constructor(private readonly ctx: Context, private readonly fence: HostFence, private readonly scope: SessionScope,
    private readonly adapter: SessionAdapter, private readonly interactions?: InteractionBridge, private readonly reserve: (bytes: number) => () => void = () => () => {}) {}
  async *openWatch(watch: Watch, incoming: Fence, signal: AbortSignal, jsonBytes = DEFAULT_LIMITS.jsonBytes): AsyncIterable<StreamValue> {
    const bound = Object.freeze({ ...incoming }); const lifetime = new AbortController()
    const linked = AbortSignal.any([signal, this.fence.signal, lifetime.signal]); const queue = new ObserverQueue(this.reserve, jsonBytes)
    const valueBytes = jsonBytes - 2048
    const profile = this.scope.sessionAuthority === 'host-profile'
    const check = () => { this.fence.check(bound); linked.throwIfAborted(); if (watch.topic === 'session') this.scope.assertSession(watch.sessionId) }
    const iterators = new Set<AsyncIterator<unknown>>(); const tasks = new Set<Promise<void>>()
    let releaseProjections: (() => void) | undefined
    const projections: { [key: string]: Json } = Object.create(null); let controlReady = false; let sessionReady = false
    let controlGeneration = 0; let controlAbort: AbortController | undefined; let controlTask: Promise<void> | undefined
    let refreshTask: Promise<void> | undefined; let refreshPending = false
    const membership = () => { const key = JSON.stringify(this.scope.sessionIds()); checkJsonLength(key, DEFAULT_LIMITS.jsonBytes); return key }
    let members = watch.topic === 'sessions' && !profile ? membership() : ''
    const visibleWorkspaces = new Set<string>()
    const allowed = (id: string) => { try { this.scope.assertSession(id); return true } catch (error) { if (error instanceof ProtocolError && error.code === 'OUT_OF_SCOPE') return false; throw error } }
    const put = (value: StreamValue, generation?: number) => { check(); if (generation === undefined || generation === controlGeneration) queue.push(value, generation) }
    const track = (task: Promise<void>) => { tasks.add(task); void task.then(() => tasks.delete(task), () => tasks.delete(task)); return task }
    const abort = () => queue.end(linked.reason)
    linked.addEventListener('abort', abort, { once: true })
    const run = (source: () => Promise<AsyncIterable<unknown>> | AsyncIterable<unknown>, accept: (value: unknown) => void | Promise<void>, primary: boolean, current = () => true) => {
      const task = (async () => {
        let iterator: AsyncIterator<unknown> | undefined
        try {
          check(); iterator = (await source())[Symbol.asyncIterator](); iterators.add(iterator); check(); if (!current()) return
          while (true) { const next = await iterator.next(); check(); if (!current()) return; if (next.done) break; await accept(next.value) }
          if (!current()) return
          if (primary) queue.end()
          else if (!linked.aborted) throw new ProtocolError('RESULT_UNCERTAIN', 'Workspace observer ended')
        } catch (error) { if (current()) { queue.end(error); lifetime.abort(error) } }
        finally { try { await iterator?.return?.() } catch (error) { if (current() && !linked.aborted) queue.end(error) } if (iterator) iterators.delete(iterator) }
      })()
      return track(task)
    }
    const budgetProjections = () => { releaseProjections?.(); releaseProjections = undefined; releaseProjections = this.reserve(Buffer.byteLength(JSON.stringify(projections)) + 128) }
    const startControl = () => {
      const generation = controlGeneration; let ready = false; controlAbort = new AbortController()
      const controlSignal = AbortSignal.any([linked, controlAbort.signal])
      controlTask = run(() => this.ctx.typertGateway.stream({ namespace: 'session', method: 'control', args: {}, signal: controlSignal }), value => {
        const frame = jsonObject(publicJson(value, valueBytes))
        if (!ready && frame.type !== 'baseline') invalid()
        if (frame.type === 'baseline') {
          ready = true; controlReady = true
          fields(frame, ['type', 'value']); const baseline = jsonObject(frame.value); fields(baseline, ['projections']); const values = jsonObject(baseline.projections)
          if (profile) { for (const projection of Object.values(values)) projectionBaseline(projection); put({ kind: 'dsh', value: frame }, generation); return }
          for (const id of Object.keys(projections)) delete projections[id]
          for (const [id, projection] of Object.entries(values)) { projectionBaseline(projection); if (allowed(id)) projections[id] = projection }
          budgetProjections(); put({ kind: 'dsh', value: { type: 'baseline', value: { projections: { ...projections } } } }, generation)
        } else if (frame.type === 'projection') {
          fields(frame, ['type', 'sessionId', 'key', 'value', 'seq']); text(frame.sessionId); text(frame.key); integer(frame.seq)
          if (!Object.hasOwn(frame, 'value')) invalid()
          if (!allowed(frame.sessionId)) return
          if (profile) { put({ kind: 'dsh', value: frame }, generation); put({ kind: 'stop-token', sessionId: frame.sessionId, token: this.adapter.currentStopToken(frame.sessionId) }, generation); return }
          const previous = projections[frame.sessionId]; const values = previous ? jsonObject(jsonObject(previous).values) : {}
          projections[frame.sessionId] = { asOfSeq: frame.seq, values: { ...values, [frame.key]: frame.value } }
          budgetProjections(); put({ kind: 'dsh', value: frame }, generation); put({ kind: 'stop-token', sessionId: frame.sessionId, token: this.adapter.currentStopToken(frame.sessionId) }, generation)
        } else invalid()
      }, true, () => generation === controlGeneration)
    }
    const refreshControl = () => {
      // Native control already observes every session in this profile. Group edits
      // do not change its authority, and another baseline would violate its stream.
      if (this.scope.sessionAuthority === 'host-profile') return
      const nextMembers = membership(); if (nextMembers === members) return; members = nextMembers
      controlGeneration++; controlAbort?.abort(); queue.discardControl()
      for (const id of Object.keys(projections)) if (!allowed(id)) delete projections[id]
      budgetProjections(); if (controlReady) put({ kind: 'dsh', value: { type: 'baseline', value: { projections: { ...projections } } } }, controlGeneration)
      refreshPending = true
      if (refreshTask) return
      // One retiring producer and one coalesced refresh; never accumulate subscriptions.
      refreshTask = track((async () => {
        try {
          while (refreshPending) {
            refreshPending = false; await controlTask; check()
            if (refreshPending) continue
            startControl()
          }
        } catch (error) { queue.end(error); lifetime.abort(error) }
        finally { refreshTask = undefined }
      })())
    }
    try {
      check()
      if (watch.topic === 'interactions') {
        if (!this.interactions) throw new ProtocolError('PROTOCOL_UNSUPPORTED')
        const bridge = this.interactions
        const task = (async () => {
          try { for await (const value of bridge.open(linked)) put(value); queue.end() }
          catch (error) { queue.end(error); lifetime.abort(error) }
        })()
        track(task)
        run(() => this.ctx.typertGateway.stream({ namespace: 'workspace', method: 'follow', args: {}, signal: linked }), async () => {
          for (const value of await bridge.scopeChanged()) put(value)
        }, false)
      } else {
        if (watch.topic !== 'workspaces') run(() => this.ctx.typertGateway.stream({ namespace: 'workspace', method: 'follow', args: {}, signal: linked }), () => {
          check()
          if (watch.topic === 'sessions') refreshControl()
        }, false)
        if (watch.topic === 'session') run(() => boundedSessionFollow(this.ctx, watch.sessionId, watch.maxMessages, linked, check, watch.turnWindow, valueBytes), value => {
          const frame = validateFollowFrame(value, valueBytes); const object = jsonObject(frame)
          if (!sessionReady && object.type !== 'snapshot') invalid()
          sessionReady = true
          if (object.type === 'snapshot' && jsonObject(object.header).id !== watch.sessionId) invalid()
          put({ kind: 'dsh', value: frame }); put({ kind: 'stop-token', sessionId: watch.sessionId, token: this.adapter.currentStopToken(watch.sessionId) })
        }, true)
        else if (watch.topic === 'sessions') startControl()
        else run(() => this.ctx.typertGateway.stream({ namespace: 'workspace', method: 'follow', args: {}, signal: linked }), value => {
          const frame = publicJson(value, valueBytes); workspaceFrame(frame, this.scope, allowed, new Set(visibleWorkspaces))
          put({ kind: 'dsh', value: frame })
        }, true)
      }
      while (true) {
        const next = await queue.next(); if (next.done) { check(); break }
        try {
        check()
        if (next.value.generation !== undefined && next.value.generation !== controlGeneration) continue
        let value = next.value.value
        if (value.kind === 'stop-token') { if (!allowed(value.sessionId)) continue; value = { ...value, token: this.adapter.currentStopToken(value.sessionId) } }
        else if (value.kind === 'interaction') {
          try { this.interactions!.assertDelivery(value.deliveryId) } catch (error) { if (error instanceof ProtocolError && (error.code === 'OUT_OF_SCOPE' || error.code === 'STALE_ACTION')) continue; throw error }
        } else if (value.kind === 'dsh' && watch.topic === 'workspaces') {
          const filtered = workspaceFrame(value.value, this.scope, allowed, visibleWorkspaces); if (!filtered) continue; value = { kind: 'dsh', value: filtered }
        } else if (value.kind === 'dsh' && watch.topic === 'sessions') {
          const frame = jsonObject(value.value)
          if (frame.type === 'baseline') { if (!profile) { const values = jsonObject(jsonObject(frame.value).projections); value = { kind: 'dsh', value: { type: 'baseline', value: { projections: Object.fromEntries(Object.entries(values).filter(([id]) => allowed(id))) } } } } }
          else { text(frame.sessionId); if (!allowed(frame.sessionId)) continue }
        } else if (value.kind === 'dsh' && watch.topic === 'interactions') {
          const frame = jsonObject(value.value); if (!Array.isArray(frame.args)) invalid(); const first = frame.args[0]; const id = typeof first === 'string' ? first : jsonObject(first).sessionId; text(id); if (!allowed(id)) continue
        }
        // Ownership transfers to the consumer before it reserves serialized output.
        check(); next.value.release(); next.value.release = () => {}; yield value
        } finally { next.value.release() }
      }
    } finally {
      lifetime.abort(); queue.clear(); releaseProjections?.(); linked.removeEventListener('abort', abort)
      await Promise.allSettled([...iterators].map(iterator => iterator.return?.()))
      await Promise.allSettled(tasks)
    }
  }
}
function workspaceFrame(value: Json, scope: SessionScope, allowed: (id: string) => boolean, visible: Set<string>): Json | undefined {
  const frame = jsonObject(value)
  const ids = (value: Json | undefined, session: boolean) => {
    if (!Array.isArray(value)) invalid()
    return value.filter(id => { text(id); if (session) return allowed(id); try { scope.assertWorkspace(id); return true } catch (error) { if (error instanceof ProtocolError && error.code === 'OUT_OF_SCOPE') return false; throw error } })
  }
  const row = (value: Json | undefined) => {
    const workspace = jsonObject(value); fields(workspace, ['workspaceId', 'path', 'title', 'sessionIds', 'createdAt', 'updatedAt'])
    for (const key of ['workspaceId', 'path', 'title', 'createdAt', 'updatedAt']) if (typeof workspace[key] !== 'string') invalid()
    text(workspace.workspaceId)
    try { scope.assertWorkspace(workspace.workspaceId) } catch (error) { if (error instanceof ProtocolError && error.code === 'OUT_OF_SCOPE') return; throw error }
    visible.add(workspace.workspaceId)
    return { ...workspace, sessionIds: ids(workspace.sessionIds, true) }
  }
  if (frame.type === 'baseline') {
    fields(frame, ['type', 'value']); const baseline = jsonObject(frame.value); fields(baseline, ['items', 'archivedSessionIds', 'pinnedSessionIds']); if (!Array.isArray(baseline.items)) invalid()
    return { type: 'baseline', value: { items: baseline.items.map(row).filter(item => item !== undefined), archivedSessionIds: ids(baseline.archivedSessionIds, true), pinnedSessionIds: ids(baseline.pinnedSessionIds, true) } }
  }
  if (frame.type === 'upsert') { fields(frame, ['type', 'workspace']); const workspace = row(frame.workspace); return workspace ? { type: 'upsert', workspace } : undefined }
  if (frame.type === 'remove') { fields(frame, ['type', 'workspaceId']); text(frame.workspaceId); if (!visible.delete(frame.workspaceId)) return; return frame }
  if (frame.type === 'order') { fields(frame, ['type', 'workspaceIds']); return { type: 'order', workspaceIds: ids(frame.workspaceIds, false) } }
  if (frame.type === 'archived') { fields(frame, ['type', 'archivedSessionIds']); return { type: 'archived', archivedSessionIds: ids(frame.archivedSessionIds, true) } }
  if (frame.type === 'pinned') { fields(frame, ['type', 'pinnedSessionIds']); return { type: 'pinned', pinnedSessionIds: ids(frame.pinnedSessionIds, true) } }
  return invalid()
}

/** Retry only an oversized initial snapshot. Each rejected subscription drains before the next opens.
 * Native maxMessages counts surface messages, including all intervening rich events, not wire bytes.
 */
async function* boundedSessionFollow(ctx: Context, sessionId: string, requested: number, signal: AbortSignal, check: () => void, turnWindow?: import('../../protocol/src/index.ts').TurnWindow, byteLimit = SESSION_JSON_BYTES): AsyncIterable<Json> {
  let maxMessages = Math.min(64, requested)
  while (true) {
    check(); const lifetime = new AbortController(); const linked = AbortSignal.any([signal, lifetime.signal])
    let iterator: AsyncIterator<unknown> | undefined
    try {
      iterator = (await ctx.typertGateway.stream({ namespace: 'session', method: 'follow', args: { request: { address: { kind: 'session', sessionId }, assistantStream: true, maxMessages, ...(turnWindow ? { turnWindow: { ...turnWindow, minMessages: Math.min(turnWindow.minMessages, maxMessages) } } : {}) } }, signal: linked }))[Symbol.asyncIterator]()
      check()
      const opening = await iterator.next(); check()
      if (opening.done) throw new ProtocolError('RESYNC_REQUIRED')
      let frame: Json
      try { frame = validateFollowFrame(opening.value, byteLimit) }
      catch (error) {
        if (!(error instanceof ProtocolError) || error.code !== 'LIMIT_EXCEEDED' || maxMessages === 1) throw error
        maxMessages = Math.max(1, Math.floor(maxMessages / 2)); continue
      }
      if (jsonObject(frame).type !== 'snapshot') invalid()
      yield frame
      while (true) {
        const next = await iterator.next(); check()
        if (next.done) return
        yield validateFollowFrame(next.value, byteLimit)
      }
    } finally { lifetime.abort(); await iterator?.return?.() }
  }
}
