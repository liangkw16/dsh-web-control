import { expect, test, vi } from 'vitest'
import { EventLedger } from '../src/adapter/events.ts'
import { InteractionBridge, sharedEventReply } from '../src/interactions.ts'
import { HostFence } from '../src/control-fence.ts'
const incoming = { instanceId: '11111111-1111-4111-8111-111111111111', runtimeId: '22222222-2222-4222-8222-222222222222', controlId: '33333333-3333-4333-8333-333333333333', authEpoch: 1 }
function fixture(frames: unknown[]) {
  const identity = { instanceId: incoming.instanceId, authEpoch: incoming.authEpoch, enabled: true, relayOrigin: 'https://relay.test', deviceSecret: Buffer.alloc(32, 1).toString('base64url'), linkSecret: Buffer.alloc(32, 2).toString('base64url') }
  const fence = new HostFence(incoming.instanceId, incoming.runtimeId, () => identity); fence.install(incoming)
  const reply = vi.fn(async (_result: import('@deepseek-ai/dsh-api-gateway/stream-protocol').RemoteEventResult) => {}); const scope = vi.fn((id: string): void | Promise<void> => { if (id !== 'a') throw new Error('OUT_OF_SCOPE') })
  const source = vi.fn(async function* (_signal: AbortSignal) { yield { type: 'ready', clientId: 'client-a', host: { home: '/private' } }; yield* frames })
  const bridge = new InteractionBridge(incoming, fence, source, scope, reply)
  return { bridge, reply, source, scope, identity, fence }
}
const approval = { type: 'waterfall', eventId: 'native-a', agentId: 'a', event: 'approval/request', request: { toolName: 'fixture', reason: 'Allow once?' } }
test('browser cannot choose another clients event identity', () => {
  const ledger = new EventLedger(); const id = ledger.record('client-a', 'event-a')
  expect(ledger.take('event-from-another-client')).toBeUndefined()
  expect(ledger.take(id)).toEqual({ clientId: 'client-a', eventId: 'event-a' }); expect(ledger.take(id)).toBeUndefined()
})
test('unknown and out-of-scope waterfalls next through native chain', async () => {
  const { bridge, reply } = fixture([{ ...approval, event: 'unknown' }, { ...approval, agentId: 'other' }])
  const values = []; for await (const value of bridge.open(new AbortController().signal)) values.push(value); expect(values).toEqual([{ kind: 'interactions-ready' }])
  expect(reply.mock.calls).toEqual([[{ clientId: 'client-a', eventId: 'native-a', outcome: { kind: 'next' } }], [{ clientId: 'client-a', eventId: 'native-a', outcome: { kind: 'next' } }]])
})
test('invalid answers retain pending delivery; valid once reply consumes it and forgery fails', async () => {
  const { bridge, reply } = fixture([approval]); const it = bridge.open(new AbortController().signal)[Symbol.asyncIterator]()
  await it.next(); const value = (await it.next()).value!; if (value.kind !== 'interaction') throw new Error('missing interaction')
  expect(value).not.toHaveProperty('clientId'); expect(value.deliveryId).not.toBe('native-a')
  await expect(bridge.answer(value.deliveryId, 'allowed-always')).rejects.toThrow('INVALID_MESSAGE')
  await expect(bridge.answer('native-a', 'allowed-once')).rejects.toThrow('STALE_ACTION')
  expect(await bridge.answer(value.deliveryId, 'allowed-once')).toEqual({ accepted: true })
  await expect(bridge.answer(value.deliveryId, 'rejected')).rejects.toThrow('STALE_ACTION')
  expect(reply).toHaveBeenCalledTimes(1); await it.return?.()
})
test('local winner cancellation removes remote delivery and disconnect never answers', async () => {
  const { bridge, reply } = fixture([approval, { type: 'cancel', eventId: 'native-a' }]); const it = bridge.open(new AbortController().signal)[Symbol.asyncIterator]()
  await it.next(); const first = (await it.next()).value!; if (first.kind !== 'interaction') throw new Error('missing')
  expect((await it.next()).value).toEqual({ kind: 'interaction-cancel', deliveryId: first.deliveryId })
  await expect(bridge.answer(first.deliveryId, 'rejected')).rejects.toThrow('STALE_ACTION')
  await bridge.dispose(); await it.return?.(); expect(reply).not.toHaveBeenCalled()
})
test('revocation during scope await prevents reply mutation', async () => {
  const { bridge, scope, identity, reply } = fixture([approval]); const it = bridge.open(new AbortController().signal)[Symbol.asyncIterator]()
  await it.next(); const first = (await it.next()).value!; if (first.kind !== 'interaction') throw new Error('missing')
  scope.mockImplementationOnce(async () => { identity.authEpoch++ })
  await expect(bridge.answer(first.deliveryId, 'rejected')).rejects.toThrow('AUTH_REVOKED')
  expect(reply).not.toHaveBeenCalled(); await bridge.dispose(); await it.return?.()
})
test('question answers match exact ids/options and single selection', async () => {
  const { bridge, reply } = fixture([{ ...approval, event: 'user-questions/request', request: { questions: [{ id: 'q', question: 'Choose', options: [{ label: 'A' }, { label: 'B' }] }] } }])
  const it = bridge.open(new AbortController().signal)[Symbol.asyncIterator](); await it.next(); const first = (await it.next()).value!
  if (first.kind !== 'interaction') throw new Error('missing')
  for (const answer of [{ answers: [{ id: 'forged', selected: ['A'] }] }, { answers: [{ id: 'q', selected: ['C'] }] }, { answers: [{ id: 'q', selected: ['A', 'B'] }] }]) await expect(bridge.answer(first.deliveryId, answer)).rejects.toThrow('INVALID_MESSAGE')
  await bridge.answer(first.deliveryId, { answers: [{ id: 'q', selected: ['A'] }] }); expect(reply).toHaveBeenCalledTimes(1); await it.return?.()
})
test('shared reply uses exact RPC envelope and rejects business failure', async () => {
  const fetch = vi.fn(async (_request: Request) => Response.json({ type: 'server-response', result: { ok: false, error: { code: 'failure' } } }))
  const reply = sharedEventReply(fetch)
  await expect(reply({ clientId: 'c' as never, eventId: 'e' as never, outcome: { kind: 'next' } })).rejects.toThrow('RESULT_UNCERTAIN')
  const req = fetch.mock.calls[0][0]; expect(req.url).toBe('http://dsh.internal/api/$events/result')
  expect(await req.json()).toMatchObject({ type: 'client-request', method: '$events/result', payload: { args: { clientId: 'c', eventId: 'e', outcome: { kind: 'next' } } } })
})

test('native projected null-prototype request is copied without exposing identity', async () => {
  const { bridge } = fixture([{ ...approval, request: Object.assign(Object.create(null), approval.request) }]); const it = bridge.open(new AbortController().signal)[Symbol.asyncIterator](); await it.next(); const value = (await it.next()).value!; expect(value).toMatchObject({ kind: 'interaction', request: approval.request }); await it.return?.()
})

test('quiet pending interaction losing scope delegates and removes the browser delivery', async () => {
  const { bridge, reply, scope } = fixture([approval]); const it = bridge.open(new AbortController().signal)[Symbol.asyncIterator]()
  await it.next(); const first = (await it.next()).value!; if (first.kind !== 'interaction') throw new Error('missing')
  scope.mockImplementation(() => { throw new Error('OUT_OF_SCOPE') })
  expect(await bridge.scopeChanged()).toEqual([{ kind: 'interaction-cancel', deliveryId: first.deliveryId }])
  expect(reply).toHaveBeenCalledWith({ clientId: 'client-a', eventId: 'native-a', outcome: { kind: 'next' } })
  await expect(bridge.answer(first.deliveryId, 'allowed-once')).rejects.toThrow('STALE_ACTION'); await it.return?.()
})
test('disposal of a still-pending interaction never chooses an answer or next', async () => {
  const { bridge, reply } = fixture([approval]); const it = bridge.open(new AbortController().signal)[Symbol.asyncIterator](); await it.next(); await it.next()
  await bridge.dispose(); await it.return?.(); expect(reply).not.toHaveBeenCalled()
})

test('dispose awaits delayed source acquisition and closes it before returning without answering', async () => {
  const { fence, scope, reply } = fixture([]); const acquisition = Promise.withResolvers<AsyncIterable<unknown>>()
  const next = vi.fn(async () => ({ done: true, value: undefined })); const close = vi.fn(async () => ({ done: true, value: undefined }))
  const bridge = new InteractionBridge(incoming, fence, () => acquisition.promise, scope, reply)
  const iterator = bridge.open(new AbortController().signal)[Symbol.asyncIterator](); const reading = iterator.next().catch(error => error)
  await Promise.resolve(); let settled = false; const disposing = bridge.dispose().then(() => { settled = true })
  await Promise.resolve(); expect(settled).toBe(false)
  acquisition.resolve({ [Symbol.asyncIterator]: () => ({ next, return: close }) })
  await disposing; expect(await reading).toBeInstanceOf(Error); expect(next).not.toHaveBeenCalled(); expect(close).toHaveBeenCalled(); expect(reply).not.toHaveBeenCalled()
})
test('async-only scope checker is refused at final synchronous admission', async () => {
  const { fence, reply } = fixture([]); const bridge = new InteractionBridge(incoming, fence, async function* () { yield { type: 'ready', clientId: 'c', host: { home: '' } }; yield approval }, async () => {}, reply)
  const it = bridge.open(new AbortController().signal)[Symbol.asyncIterator](); await it.next(); await expect(it.next()).rejects.toThrow('PROTOCOL_UNSUPPORTED'); expect(reply).not.toHaveBeenCalled()
})

test('oversized unforwarded waterfall payloads still delegate unknown and out-of-scope events', async () => {
  const request = { toolName: 'fixture', reason: 'x'.repeat(1024 * 1024) }
  const { bridge, reply } = fixture([{ ...approval, event: 'unknown', request }, { ...approval, agentId: 'other', request }])
  for await (const value of bridge.open(new AbortController().signal)) expect(value).toEqual({ kind: 'interactions-ready' })
  expect(reply).toHaveBeenCalledTimes(2); expect(reply.mock.calls.every(([result]) => result.outcome.kind === 'next')).toBe(true)
})

test('answer validation snapshots the payload before awaited scope preparation', async () => {
  const { bridge, scope, reply } = fixture([{ ...approval, event: 'user-questions/request', request: { questions: [{ id: 'q', question: 'Choose', options: [{ label: 'A' }, { label: 'B' }] }] } }])
  const it = bridge.open(new AbortController().signal)[Symbol.asyncIterator](); await it.next(); const first = (await it.next()).value!; if (first.kind !== 'interaction') throw new Error('missing')
  const answer = { answers: [{ id: 'q', selected: ['A'] }] }
  scope.mockImplementationOnce(async () => { answer.answers[0].selected = ['B'] })
  await bridge.answer(first.deliveryId, answer)
  expect(reply).toHaveBeenCalledWith({ clientId: 'client-a', eventId: 'native-a', outcome: { kind: 'result', value: { answers: [{ id: 'q', selected: ['A'] }] } } }); await it.return?.()
})

import { HostBudget } from '../src/host-transport.ts'
test('retained interaction competes with transfers/socket buffers and releases exactly once', async () => {
  const f = fixture([approval]); const budget = new HostBudget(1000); const releaseTransfer = budget.reserve(600)
  const bridge = new InteractionBridge(incoming, f.fence, f.source, () => {}, f.reply, budget.reserve)
  const iterator = bridge.open(new AbortController().signal)[Symbol.asyncIterator](); await iterator.next(); const item = (await iterator.next()).value!
  expect(budget.bytes).toBeGreaterThan(600); expect(() => budget.reserve(300)).toThrow('RESYNC_REQUIRED')
  if (item.kind !== 'interaction') throw new Error('missing')
  await bridge.answer(item.deliveryId, 'rejected'); expect(budget.bytes).toBe(600)
  await iterator.return?.(); await bridge.dispose(); releaseTransfer(); expect(budget.bytes).toBe(0)
})

test('authenticated event readiness is explicit even with no pending deliveries', async () => {
  const { bridge } = fixture([]); const iterator = bridge.open(new AbortController().signal)[Symbol.asyncIterator]()
  expect((await iterator.next()).value).toEqual({ kind: 'interactions-ready' }); expect((await iterator.next()).done).toBe(true)
})
test('interaction projection carries scoped session identity but never native client identity', async () => {
  const { bridge } = fixture([approval]); const iterator = bridge.open(new AbortController().signal)[Symbol.asyncIterator]()
  await iterator.next(); const value = (await iterator.next()).value
  expect(value).toMatchObject({ kind: 'interaction', sessionId: 'a' }); expect(value).not.toHaveProperty('clientId'); await iterator.return?.()
})

test('native delegation uses next once and canceled operation cannot answer after scope await', async () => {
  const f = fixture([approval]), it = f.bridge.open(new AbortController().signal)[Symbol.asyncIterator]()
  await it.next(); const item = (await it.next()).value!; if (item.kind !== 'interaction') throw new Error('missing')
  await f.bridge.delegate(item.deliveryId)
  expect(f.reply).toHaveBeenCalledExactlyOnceWith({clientId:'client-a',eventId:'native-a',outcome:{kind:'next'}})
  await expect(f.bridge.delegate(item.deliveryId)).rejects.toThrow('STALE_ACTION'); await it.return?.()
  for (const method of ['answer','delegate'] as const) {
    const f=fixture([approval]),it=f.bridge.open(new AbortController().signal)[Symbol.asyncIterator](),life=new AbortController()
    await it.next();const item=(await it.next()).value!;if(item.kind!=='interaction')throw new Error('missing')
    if(method==='delegate')f.scope.mockImplementationOnce(()=>{})
    f.scope.mockImplementationOnce(async()=>{life.abort()})
    // Operation cancellation is separate from the still-valid control lease.
    const result=method==='answer'?f.bridge.answer(item.deliveryId,'allowed-once',life.signal):f.bridge.delegate(item.deliveryId,life.signal)
    await expect(result).rejects.toThrow();expect(f.reply).not.toHaveBeenCalled();await it.return?.()
  }
})
