import { expect, test, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { LiveStreams } from '../src/streams.ts'
import { validateFollowFrame } from '../src/adapter/dsh-v021.ts'
import { SessionScope } from '../src/adapter/scope.ts'
import { HostFence } from '../src/control-fence.ts'
import type { SessionAdapter } from '../src/adapter/types.ts'
const incoming = { instanceId: '11111111-1111-4111-8111-111111111111', runtimeId: '22222222-2222-4222-8222-222222222222', controlId: '33333333-3333-4333-8333-333333333333', authEpoch: 1 }
const snapshot = { type: 'snapshot', header: { id: 'a', version: 1, createdAt: 1, isSeeded: false }, cursor: 0, records: [], hasMore: false, projections: { asOfSeq: 0, values: {} }, assistantStream: { revision: 2, activeAttempt: { attemptId: 'x', startedAfterSeq: 0, turn: 0, step: 0, nextIndex: 1, stream: [{ type: 'text', text: 'baseline' }] } } }
function fixture(authority: 'registered-workspaces' | 'host-profile' = 'registered-workspaces') {
  let members = ['a']; let notify: (() => void) | undefined; const disposed = vi.fn(); let querySignal: AbortSignal | undefined
  const stream = vi.fn(async ({ namespace, signal }: { namespace: string; signal: AbortSignal }): Promise<AsyncIterable<unknown>> => {
    if (namespace === 'workspace') return (async function* () { yield { type: 'baseline', value: { items: [] } }; await new Promise<void>(resolve => { notify = resolve; signal.addEventListener('abort', () => resolve(), { once: true }) }); if (!signal.aborted) yield { type: 'baseline', value: { items: [] } } })()
    querySignal = signal
    return (async function* () { try { yield snapshot; await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })) } finally { disposed() } })()
  })
  const ctx = { typertGateway: { stream }, sessionController: { cancel: vi.fn() } } as unknown as Context
  const identity = { instanceId: incoming.instanceId, authEpoch: incoming.authEpoch, enabled: true, relayOrigin: 'https://relay.test', deviceSecret: Buffer.alloc(32, 1).toString('base64url'), linkSecret: Buffer.alloc(32, 2).toString('base64url') }
  const fence = new HostFence(incoming.instanceId, incoming.runtimeId, () => identity); fence.install(incoming)
  const scope = new SessionScope(() => [{ workspaceId: 'w', sessionIds: members }], undefined, authority)
  const adapter = { currentStopToken: () => 'stop' } as unknown as SessionAdapter
  return { fence, scope, adapter, streams: new LiveStreams(ctx, fence, scope, adapter), stream, ctx, disposed, get signal() { return querySignal }, setMembers: (next: string[]) => { members = next }, revoke: () => { members = []; notify?.() } }
}
test('follow opening preserves assistant baseline and follow descriptor, then stop capability', async () => {
  const f = fixture(); const it = f.streams.openWatch({ topic: 'session', sessionId: 'a', maxMessages: 64 }, incoming, new AbortController().signal)[Symbol.asyncIterator]()
  expect((await it.next()).value).toEqual({ kind: 'dsh', value: snapshot })
  expect((await it.next()).value).toEqual({ kind: 'stop-token', sessionId: 'a', token: 'stop' })
  expect(f.stream.mock.calls.some(([req]) => req.namespace === 'session' && JSON.stringify(req).includes('assistantStream'))).toBe(true)
  await it.return?.(); expect(f.signal?.aborted).toBe(true); expect(f.ctx.sessionController.cancel).not.toHaveBeenCalled(); expect(f.disposed).toHaveBeenCalled()
})
test('workspace loss terminates idle follow without Agent cancellation', async () => {
  const f = fixture(); const it = f.streams.openWatch({ topic: 'session', sessionId: 'a', maxMessages: 64 }, incoming, new AbortController().signal)[Symbol.asyncIterator]()
  await it.next(); await it.next(); const next = it.next(); f.revoke(); await expect(next).rejects.toThrow('OUT_OF_SCOPE')
  expect(f.disposed).toHaveBeenCalled(); expect(f.ctx.sessionController.cancel).not.toHaveBeenCalled()
})
test('validator rejects malformed frame interiors instead of casting raw objects', () => {
  expect(validateFollowFrame(snapshot)).toEqual(snapshot)
  for (const bad of [{ ...snapshot, records: [{}] }, { ...snapshot, assistantStream: { revision: 1, activeAttempt: {} } }, { type: 'assistant-stream', frame: { type: 'chunk' } }, { ...snapshot, projections: { values: [] } }]) expect(() => validateFollowFrame(bad)).toThrow('INVALID_MESSAGE')
})

import { publicJson } from '../src/adapter/dsh-v021.ts'
test('public JSON copy accepts native records but rejects forbidden descriptors, cycles and oversize before copying', () => {
  expect(publicJson(Object.assign(Object.create(null), { nested: { value: 'safe' } }))).toEqual({ nested: { value: 'safe' } })
  const hidden = Object.defineProperty({}, 'value', { value: 'hidden' }); const getter = Object.defineProperty({}, 'value', { enumerable: true, get: () => { throw new Error('must never execute') } })
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic
  for (const value of [hidden, getter, { [Symbol('private')]: true }, cyclic, new Date(), { value: Infinity }]) expect(() => publicJson(value)).toThrow('INVALID_MESSAGE')
  expect(() => publicJson({ value: 'x'.repeat(256 * 1024) })).toThrow('LIMIT_EXCEEDED')
})
test('opted large control baseline and progress retain complete native payloads', async () => {
  const f=fixture('host-profile'), payload='进度'.repeat(60000)
  const baseline={type:'baseline',value:{projections:{a:{asOfSeq:1,values:{title:'Large session',progress:payload}}}}}
  const update={type:'projection',sessionId:'a',key:'progress',value:payload+' complete',seq:2}
  f.stream.mockImplementation(async ({namespace,signal})=>namespace==='workspace'?(async function*(){await new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}))})():(async function*(){yield baseline;yield update;await new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}))})())
  const controller=new AbortController(), it=f.streams.openWatch({topic:'sessions'},incoming,controller.signal,1024*1024)[Symbol.asyncIterator]()
  try {
    expect((await it.next()).value).toEqual({kind:'dsh',value:baseline})
    expect((await it.next()).value).toEqual({kind:'dsh',value:update})
  } finally {controller.abort();await it.return?.()}
  expect(f.ctx.sessionController.cancel).not.toHaveBeenCalled()
})

test('scoped control baseline and queued projection are rechecked at actual emission', async () => {
  const f = fixture(); const release = Promise.withResolvers<void>()
  f.stream.mockImplementation(async ({ namespace, signal }) => namespace === 'workspace' ? (async function* () { await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })) })() : (async function* () {
    yield { type: 'baseline', value: { projections: { a: { asOfSeq: 1, values: { turnBoundary: {} } }, foreign: { asOfSeq: 1, values: { secret: true } } } } }
    yield { type: 'projection', sessionId: 'a', key: 'turnBoundary', value: {}, seq: 2 }
    await release.promise
    yield { type: 'projection', sessionId: 'b', key: 'turnBoundary', value: {}, seq: 3 }
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
  })())
  const controller = new AbortController(); const it = f.streams.openWatch({ topic: 'sessions' }, incoming, controller.signal)[Symbol.asyncIterator]()
  expect((await it.next()).value).toEqual({ kind: 'dsh', value: { type: 'baseline', value: { projections: { a: { asOfSeq: 1, values: { turnBoundary: {} } } } } } })
  await Promise.resolve(); f.setMembers(['b'])
  const next = it.next(); release.resolve()
  expect((await next).value).toEqual({ kind: 'dsh', value: { type: 'projection', sessionId: 'b', key: 'turnBoundary', value: {}, seq: 3 } })
  controller.abort(); await it.return?.(); expect(f.ctx.sessionController.cancel).not.toHaveBeenCalled()
})

function controlFixture(authority: 'registered-workspaces' | 'host-profile' = 'registered-workspaces') {
  const f = fixture(authority); let wake: (() => void) | undefined; let updates = 0
  const full = { a: { asOfSeq: 3, values: { title: 'quiet a', status: 'idle' } }, b: { asOfSeq: 7, values: { title: 'quiet b', status: 'idle' } } }
  const opening = { type: 'baseline', value: { projections: full } }
  const control = vi.fn(async (signal: AbortSignal): Promise<AsyncIterable<unknown>> => (async function* () { yield opening; await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }) }) })())
  f.stream.mockImplementation(async ({ namespace, signal }) => namespace === 'workspace' ? (async function* () {
    while (!signal.aborted) {
      if (!updates) await new Promise<void>(resolve => { wake = resolve; if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }) })
      if (signal.aborted) break
      updates--; yield { type: 'upsert' }
    }
  })() : control(signal))
  const controller = new AbortController(); const it = f.streams.openWatch({ topic: 'sessions' }, incoming, controller.signal)[Symbol.asyncIterator]()
  return { ...f, full, opening, control, controller, it, change: (members: string[]) => { f.setMembers(members); updates++; wake?.() } }
}
async function baselineWith(it: AsyncIterator<unknown>, id: string, seen: unknown[] = []) {
  for (let count = 0; count < 4; count++) {
    let timer: ReturnType<typeof setTimeout> | undefined
    const next = await Promise.race([it.next(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Missing complete scoped baseline')), 200) })]).finally(() => clearTimeout(timer))
    const value = next.value as { kind: string; value?: { type: string; value: { projections: Record<string, unknown> } } }
    seen.push(value)
    if (value.kind === 'dsh' && value.value?.type === 'baseline' && Object.hasOwn(value.value.value.projections, id)) return value.value.value.projections
  }
  throw new Error('Missing complete scoped baseline')
}
test('quiet excluded session gains its complete current baseline without a projection mutation', async () => {
  const f = controlFixture()
  try {
    await f.it.next(); f.change(['a', 'b'])
    expect(await baselineWith(f.it, 'b')).toEqual(f.full)
    f.change(['a', 'b']); await new Promise<void>(resolve => setImmediate(resolve)); expect(f.control).toHaveBeenCalledTimes(2)
  } finally { f.controller.abort(); await f.it.return?.() }
}, 1000)
test('quiet removed and re-added session regains every projection key', async () => {
  const f = controlFixture()
  try {
    await f.it.next(); f.change([])
    expect((await f.it.next()).value).toEqual({ kind: 'dsh', value: { type: 'baseline', value: { projections: {} } } })
    f.change(['a'])
    expect(await baselineWith(f.it, 'a')).toEqual({ a: f.full.a })
  } finally { f.controller.abort(); await f.it.return?.() }
}, 1000)
test('obsolete queued deltas and delayed producer opening cannot overwrite a replacement baseline', async () => {
  const f = controlFixture(); const release = Promise.withResolvers<AsyncIterable<unknown>>()
  f.control.mockImplementationOnce(async signal => (async function* () {
    yield f.opening
    yield { type: 'projection', sessionId: 'a', key: 'title', value: 'stale queued', seq: 9 }
    await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }) })
  })()).mockImplementationOnce(() => release.promise)
  try {
    await f.it.next(); await new Promise<void>(resolve => setImmediate(resolve)); expect(f.control).toHaveBeenCalledTimes(1)
    f.change(['a', 'b']); await vi.waitFor(() => expect(f.control).toHaveBeenCalledTimes(2))
    f.change(['b']);
    release.resolve((async function* () { yield { type: 'baseline', value: { projections: { b: { asOfSeq: 99, values: { title: 'obsolete opening' } } } } }; yield { type: 'projection', sessionId: 'b', key: 'title', value: 'obsolete delta', seq: 100 } })())
    const seen: unknown[] = []
    expect(await baselineWith(f.it, 'b', seen)).toEqual({ b: f.full.b })
    expect(JSON.stringify(seen)).not.toContain('stale queued'); expect(JSON.stringify(seen)).not.toContain('obsolete')
    expect(f.control).toHaveBeenCalledTimes(3)
    expect(f.ctx.sessionController.cancel).not.toHaveBeenCalled()
  } finally { f.controller.abort(); await f.it.return?.() }
}, 1000)
test('unrepresentable projection stops after seven bounded opening attempts without cancelling work', async () => {
  const f = fixture(); f.stream.mockImplementation(async ({ namespace, signal }) => namespace === 'workspace' ? (async function* () { await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })) })() : (async function* () { yield { ...snapshot, projections: { asOfSeq: 0, values: { large: 'x'.repeat(256 * 1024) } } } })())
  const it = f.streams.openWatch({ topic: 'session', sessionId: 'a', maxMessages: 64 }, incoming, new AbortController().signal)[Symbol.asyncIterator]()
  await expect(it.next()).rejects.toThrow('LIMIT_EXCEEDED')
  expect(f.stream.mock.calls.filter(([req]) => req.namespace === 'session')).toHaveLength(7); expect(f.ctx.sessionController.cancel).not.toHaveBeenCalled()
})

test('workspace baseline filters membership, archives and pins, and foreign removals never leak', async () => {
  const f = fixture()
  const workspace = { workspaceId: 'w', path: '/fixture', title: 'Fixture', sessionIds: ['a', 'foreign'], createdAt: '2026-10-08', updatedAt: '2026-10-08' }
  f.stream.mockImplementation(async ({ signal }) => (async function* () { yield { type: 'baseline', value: { items: [workspace, { ...workspace, workspaceId: 'other' }], archivedSessionIds: ['a', 'foreign'], pinnedSessionIds: ['foreign', 'a'] } }; yield { type: 'remove', workspaceId: 'other' }; yield { type: 'remove', workspaceId: 'w' }; await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })) })())
  const it = f.streams.openWatch({ topic: 'workspaces' }, incoming, new AbortController().signal)[Symbol.asyncIterator]()
  expect((await it.next()).value).toEqual({ kind: 'dsh', value: { type: 'baseline', value: { items: [{ ...workspace, sessionIds: ['a'] }], archivedSessionIds: ['a'], pinnedSessionIds: ['a'] } } })
  expect((await it.next()).value).toEqual({ kind: 'dsh', value: { type: 'remove', workspaceId: 'w' } }); await it.return?.()
})

import { readFileSync } from 'node:fs'
test('fixed sanitized native Task1 follow opening round-trips through public validation', () => {
  const value = JSON.parse(readFileSync(new URL('./fixtures/session-opening-rc2.json', import.meta.url), 'utf8'))
  expect(validateFollowFrame(value)).toEqual(value); expect(value.assistantStream).toEqual({ revision: 0 })
})

import { HostBudget } from '../src/host-transport.ts'
test('source queue reservations share the physical budget and release on quiet generation abort', async () => {
  const f = fixture(); const budget = new HostBudget(2000); const transferRelease = budget.reserve(1000)
  const streams = new LiveStreams(f.ctx, f.fence, f.scope, f.adapter, undefined, budget.reserve)
  const control = new AbortController(); const iterator = streams.openWatch({ topic: 'session', sessionId: 'a', maxMessages: 64 }, incoming, control.signal)[Symbol.asyncIterator]()
  await iterator.next(); await new Promise(resolve => setImmediate(resolve))
  expect(budget.bytes).toBeGreaterThan(1000)
  expect(() => budget.reserve(800)).toThrow('RESYNC_REQUIRED')
  control.abort(); await iterator.return?.(); expect(budget.bytes).toBe(1000); transferRelease(); expect(budget.bytes).toBe(0)
})

test('rich native history opens a smaller complete message window without losing live baseline or events', async () => {
  const f = fixture(); const history = Array.from({ length: 160 }, (_, seq) => ({ type: 'event', event: { type: seq % 5 === 0 ? 'user/message' : 'tool/result', seq, time: seq, ...(seq % 5 === 0 ? { surfaceOp: 'append' } : {}), data: { message: { role: seq % 5 === 0 ? 'user' : 'tool', content: [{ type: 'text', text: 'native rich payload ' + 'x'.repeat(seq === 1 ? 144000 : 3000) }] } } } }))
  const active = { revision: 8, activeAttempt: { attemptId: 'native', startedAfterSeq: 159, turn: 3, step: 0, nextIndex: 1, stream: [{ type: 'text-chunks', time0: 1, index: 0, dt: [], texts: ['still running'] }] } }
  let producers = 0, drained = 0; let retained = 0
  f.stream.mockImplementation(async (request: any) => {
    const { namespace, signal } = request
    if (namespace === 'workspace') return (async function* () { await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })) })()
    producers++; const count = request.args.request.maxMessages; const start = Math.max(0, 160 - count * 5)
    return (async function* () { try { yield { ...snapshot, cursor: 159, records: history.slice(start), hasMore: start > 0, assistantStream: active }; yield { type: 'event', event: { type: 'fixture/event', seq: 160, time: 160, data: {} } }; await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })) } finally { drained++ } })()
  })
  const streams = new LiveStreams(f.ctx, f.fence, f.scope, f.adapter, undefined, bytes => { retained += bytes; return () => { retained -= bytes } })
  const control = new AbortController(), it = streams.openWatch({ topic: 'session', sessionId: 'a', maxMessages: 64 }, incoming, control.signal)[Symbol.asyncIterator]()
  try {
    const first = (await it.next()).value as any
    expect(first.kind).toBe('dsh'); expect(first.value.records).toEqual(history.slice(80)); expect(first.value).toMatchObject({ cursor: 159, hasMore: true, assistantStream: active })
    expect(Buffer.byteLength(JSON.stringify({ v: 1, type: 'event', id: incoming.instanceId, fence: incoming, value: first }))).toBeLessThan(256 * 1024)
    expect((await it.next()).value).toEqual({ kind: 'stop-token', sessionId: 'a', token: 'stop' })
    expect((await it.next()).value).toEqual({ kind: 'dsh', value: { type: 'event', event: { type: 'fixture/event', seq: 160, time: 160, data: {} } } })
    expect(producers - drained).toBe(1)
  } finally { control.abort(); await it.return?.() }
  expect(retained).toBe(0); expect(drained).toBe(producers); expect(f.ctx.sessionController.cancel).not.toHaveBeenCalled()
})

test.each(['cancelled', 'out-of-scope'])('delayed native follow acquired after %s never starts a stale read and drains ownership', async mode => {
  const f = fixture(), acquired = Promise.withResolvers<AsyncIterable<unknown>>()
  const read = vi.fn(async () => ({ done: false as const, value: snapshot })), drained = vi.fn(async () => ({ done: true as const, value: undefined }))
  let retained = 0
  f.stream.mockImplementation(async request => request.namespace === 'session' ? acquired.promise : (async function* () { if (!request.signal.aborted) await new Promise<void>(resolve => request.signal.addEventListener('abort', () => resolve(), { once: true })) })())
  const control = new AbortController(), streams = new LiveStreams(f.ctx, f.fence, f.scope, f.adapter, undefined, bytes => { retained += bytes; return () => { retained -= bytes } })
  const it = streams.openWatch({ topic: 'session', sessionId: 'a', maxMessages: 64 }, incoming, control.signal)[Symbol.asyncIterator]()
  const opening = it.next(); const rejected = expect(opening).rejects.toThrow(mode === 'cancelled' ? 'selection cancelled' : 'OUT_OF_SCOPE')
  await vi.waitFor(() => expect(f.stream.mock.calls.some(([request]) => request.namespace === 'session')).toBe(true))
  if (mode === 'cancelled') control.abort(new Error('selection cancelled')); else f.setMembers([])
  acquired.resolve({ [Symbol.asyncIterator]: () => ({ next: read, return: drained }) })
  await rejected; await it.return?.()
  expect(read).not.toHaveBeenCalled(); expect(drained).toHaveBeenCalledTimes(1); expect(retained).toBe(0)
  expect(f.ctx.sessionController.cancel).not.toHaveBeenCalled()
})
test('native follow forwards turn-window with the bounded message limit and no Agent action', async () => {
  const f = fixture(), controller = new AbortController()
  const it = f.streams.openWatch({ topic: 'session', sessionId: 'a', maxMessages: 128, turnWindow: { minMessages: 100, minTurns: 2 } }, incoming, controller.signal)[Symbol.asyncIterator]()
  await it.next()
  expect(f.stream.mock.calls.find(([req]) => req.namespace === 'session')?.[0]).toMatchObject({ args: { request: { maxMessages: 64, turnWindow: { minMessages: 64, minTurns: 2 } } } })
  controller.abort(); await it.return?.(); expect(f.ctx.sessionController.cancel).not.toHaveBeenCalled()
})

test('profile control keeps one original opening while workspace grouping changes', async () => {
  const f = controlFixture('host-profile')
  try {
    expect((await f.it.next()).value).toEqual({kind:'dsh',value:f.opening})
    f.change([]);await new Promise<void>(resolve=>setImmediate(resolve))
    f.change(['new']);await new Promise<void>(resolve=>setImmediate(resolve))
    expect(f.control).toHaveBeenCalledOnce()
  } finally { f.controller.abort();await f.it.return?.() }
})
