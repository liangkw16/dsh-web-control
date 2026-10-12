import { expect, test, vi } from 'vitest'
import { dispatchCommand } from '../src/commands.ts'
import { HostFence } from '../src/control-fence.ts'
import type { SessionAdapter } from '../src/adapter/types.ts'
const instanceId = '11111111-1111-4111-8111-111111111111'
const incoming = { instanceId, runtimeId: '22222222-2222-4222-8222-222222222222', controlId: '33333333-3333-4333-8333-333333333333', authEpoch: 1 }
function fixture() {
  const identity = { instanceId, authEpoch: 1, enabled: true, relayOrigin: 'https://relay.test', deviceSecret: Buffer.alloc(32, 1).toString('base64url'), linkSecret: Buffer.alloc(32, 2).toString('base64url') }
  const fence = new HostFence(instanceId, incoming.runtimeId, () => identity)
  fence.install(incoming)
  const adapter: SessionAdapter = { withAdmission: () => adapter, assertSession: vi.fn(async () => {}), list: vi.fn(async () => ({ items: [] })), create: vi.fn(async () => ({ sessionId: 'a' })), prompt: vi.fn(async () => ({ accepted: true })), page: vi.fn(async () => ({})), currentStopToken: () => 'token', stop: vi.fn(() => ({ accepted: true })) }
  return { identity, fence, adapter, signal: new AbortController().signal }
}
test('prompt retains stable business request identity and cancellation lifetime', async () => {
  const { adapter, fence, signal } = fixture()
  const command = { op: 'session.prompt', sessionId: 'a', requestId: 'stable', mode: 'queue', content: [{ kind: 'text', text: 'hi' }] } as const
  await dispatchCommand(adapter, fence, incoming, { ...command, content: [...command.content] }, signal, {})
  expect(adapter.prompt).toHaveBeenCalledWith(command, signal)
})
test('rotation during authorization prevents atomic stop', async () => {
  const { adapter, fence, identity, signal } = fixture()
  adapter.assertSession = async () => { identity.authEpoch++ }
  await expect(dispatchCommand(adapter, fence, incoming, { op: 'session.stop', sessionId: 'a', stopToken: 'token' }, signal, {})).rejects.toThrow('AUTH_REVOKED')
  expect(adapter.stop).not.toHaveBeenCalled()
})
test('rotation during async preparation prevents additional mutation', async () => {
  const { adapter, fence, identity, signal } = fixture(); const mutate = vi.fn()
  await expect(dispatchCommand(adapter, fence, incoming, { op: 'interaction.answer', deliveryId: 'x', answer: true }, signal, {
    'interaction.answer': async (_command, _signal, admission) => { await Promise.resolve(); identity.authEpoch++; admission(); mutate(); return true },
  })).rejects.toThrow('AUTH_REVOKED')
  expect(mutate).not.toHaveBeenCalled()
})
test('rotation before returned data suppresses stale results', async () => {
  const { adapter, fence, identity, signal } = fixture()
  adapter.page = async () => { identity.authEpoch++; return {} }
  await expect(dispatchCommand(adapter, fence, incoming, { op: 'session.page', sessionId: 'a', throughSeq: 1, maxMessages: 1 }, signal, {})).rejects.toThrow('AUTH_REVOKED')
})
test('missing additional handler is explicitly unsupported', async () => {
  const { adapter, fence, signal } = fixture()
  await expect(dispatchCommand(adapter, fence, incoming, { op: 'file.changes', sessionId: 'a', seq: 1 }, signal, {})).rejects.toThrow('PROTOCOL_UNSUPPORTED')
})

import { DshSessionAdapter } from '../src/adapter/dsh-v021.ts'
import type { Context } from '@deepseek-ai/cordis'
function hostFixture() {
  let membership = ['a']
  const invoke = vi.fn(async (_request: { namespace: string; method: string; args: Record<string, unknown>; signal?: AbortSignal }): Promise<unknown> => ({ accepted: true }))
  // Synthetic structural services only; production is typechecked against public Context.
  const ctx = { workspaceRegistry: { list: () => [{ id: 'w', sessionIds: membership }] },
    typertGateway: { invoke }, agents: { get: () => undefined }, sessionProjections: { stateOf: () => undefined }, sessionController: { cancel: vi.fn(() => ({ accepted: true })), follow: vi.fn(async function* () { yield { type: 'snapshot', cursor: 12, records: [], hasMore: false, projections: { values: {} } } }), page: vi.fn(async () => ({ records: [], hasMore: false })) } } as unknown as Context
  return { ctx, invoke, setMembership: (items: string[]) => { membership = items } }
}
test('public prompt request retains all fields, ordinary receipt, and WRITER_HELD', async () => {
  const { ctx, invoke } = hostFixture(); const adapter = new DshSessionAdapter(ctx).withAdmission(() => {})
  const command = { op: 'session.prompt', sessionId: 'a', requestId: 'stable', mode: 'steer', clientTimeZone: 'Asia/Shanghai', content: [{ kind: 'text', text: 'hi' }, { kind: 'upload', receiptId: 'receipt', mediaType: 'text/plain', name: 'f' }] } satisfies Parameters<SessionAdapter['prompt']>[0]
  const signal = new AbortController().signal
  await adapter.prompt(command, signal)
  expect(invoke).toHaveBeenCalledWith({ namespace: 'session', method: 'prompt', args: { request: { sessionId: 'a', requestId: 'stable', mode: 'steer', clientTimeZone: 'Asia/Shanghai', content: [{ type: 'text', text: 'hi' }, { type: 'file', receiptId: 'receipt' }] } }, signal })
  invoke.mockRejectedValueOnce({ code: 'session/writer-held' })
  await expect(adapter.prompt(command, signal)).rejects.toThrow('WRITER_HELD')
})
test('explicit create/adopt forwards only workspaceId and sessionId', async () => {
  const { ctx, invoke, setMembership } = hostFixture(); const adapter = new DshSessionAdapter(ctx).withAdmission(() => {})
  invoke.mockImplementation(async () => { setMembership(['a', 'new']); return { sessionId: 'new' } })
  expect(await adapter.create('w', 'new')).toEqual({ sessionId: 'new' })
  expect(invoke).toHaveBeenCalledWith({ namespace: 'session', method: 'create', args: { request: { workspaceId: 'w', sessionId: 'new' } } })
})
test('list uses verified _request descriptor and filters latest membership', async () => {
  const { ctx, invoke, setMembership } = hostFixture(); const adapter = new DshSessionAdapter(ctx).withAdmission(() => {})
  invoke.mockImplementation(async () => { setMembership(['b']); return { items: [{ sessionId: 'a' }, { sessionId: 'b' }, { sessionId: 'foreign' }] } })
  expect(await adapter.list('w', 'cursor')).toEqual({ items: [{ sessionId: 'b' }] })
  expect(invoke).toHaveBeenCalledWith({ namespace: 'session', method: 'list', args: { _request: { cursor: 'cursor' } } })
})
test('unbound production methods fail closed', async () => {
  const { ctx, invoke } = hostFixture(); const adapter = new DshSessionAdapter(ctx)
  await expect(adapter.create('w', 'new')).rejects.toThrow('STALE_CONTROL')
  expect(() => adapter.stop('a', 'token')).toThrow('STALE_CONTROL')
  expect(invoke).not.toHaveBeenCalled()
})
test('simultaneous facades retain separate admission authority and copied Fence', async () => {
  const { ctx, invoke } = hostFixture(); const adapter = new DshSessionAdapter(ctx)
  const first = vi.fn(() => { throw new Error('first revoked') }); const second = vi.fn()
  const a = adapter.withAdmission(first); const b = adapter.withAdmission(second)
  await expect(a.page({ op: 'session.page', sessionId: 'a', throughSeq: 1, maxMessages: 1 }, new AbortController().signal)).rejects.toThrow('first revoked')
  await b.prompt({ op: 'session.prompt', sessionId: 'a', requestId: 'stable', mode: 'queue', content: [{ kind: 'text', text: 'hi' }] }, new AbortController().signal)
  expect(invoke).toHaveBeenCalledTimes(1)
  expect(second).toHaveBeenCalled()
})
function imageHostFixture(data = Buffer.from('synthetic-image-bytes')) {
  const base = hostFixture()
  const agent = { id: 'a', session: {}, inbox: { nextTurn: [], nextStep: [] } }
  const attachments = { imageLimits: { maxImageBytes: 100, maxImagesPerMessage: 2, maxMessageImageBytes: 100, maxImagePixels: 100, maxImageDimension: 10, mediaTypes: ['image/png'] },
    readFileStream: vi.fn(async function* () { yield data.subarray(0, 4); yield data.subarray(4) }), validateImage: vi.fn(async () => {}) }
  const binding = { commit: vi.fn(), [Symbol.dispose]: vi.fn() }
  const bindPrompt = vi.fn(() => binding)
  const ctx = { ...base.ctx, agents: { get: () => agent }, attachments, fileUploads: { resolve: () => ({ attachmentId: 'digest', name: 'verified.png', bytes: data.length }), bindPrompt } } as unknown as Context
  return { ...base, ctx, data, attachments, agent, binding, bindPrompt }
}
const imageCommand = { op: 'session.prompt', sessionId: 'a', requestId: 'stable', mode: 'queue', content: [{ kind: 'upload', receiptId: 'receipt', name: 'untrusted.png', mediaType: 'image/png' }] } satisfies Parameters<SessionAdapter['prompt']>[0]
test('image receipts become byte-validated public image content', async () => {
  const { ctx, invoke, data, attachments } = imageHostFixture()
  await new DshSessionAdapter(ctx).withAdmission(() => {}).prompt(imageCommand, new AbortController().signal)
  expect(attachments.validateImage).toHaveBeenCalledWith({ data, mediaType: 'image/png', name: 'verified.png' })
  expect(invoke.mock.calls[0][0].args).toEqual({ request: { sessionId: 'a', requestId: 'stable', mode: 'queue', content: [{ type: 'image', mediaType: 'image/png', data: data.toString('base64'), name: 'verified.png' }] } })
})
test('rotate during awaited image validation causes zero public prompt mutations', async () => {
  const { ctx, invoke, attachments } = imageHostFixture(); let valid = true
  attachments.validateImage.mockImplementation(async () => { await Promise.resolve(); valid = false })
  const guard = () => { if (!valid) throw new Error('AUTH_REVOKED') }
  await expect(new DshSessionAdapter(ctx).withAdmission(guard).prompt(imageCommand, new AbortController().signal)).rejects.toThrow('AUTH_REVOKED')
  expect(invoke).not.toHaveBeenCalled()
})
test('membership removal while reading images causes zero public prompt mutations', async () => {
  const { ctx, invoke, attachments, setMembership } = imageHostFixture()
  attachments.validateImage.mockImplementation(async () => { setMembership([]) })
  await expect(new DshSessionAdapter(ctx).withAdmission(() => {}).prompt(imageCommand, new AbortController().signal)).rejects.toThrow('OUT_OF_SCOPE')
  expect(invoke).not.toHaveBeenCalled()
})
test('image admission bounds and byte validation fail without generic-file downgrade', async () => {
  const { ctx, invoke, attachments } = imageHostFixture()
  attachments.imageLimits.maxImageBytes = 1
  await expect(new DshSessionAdapter(ctx).withAdmission(() => {}).prompt(imageCommand, new AbortController().signal)).rejects.toThrow('LIMIT_EXCEEDED')
  attachments.imageLimits.maxImageBytes = 100
  attachments.validateImage.mockRejectedValueOnce(new Error('invalid PNG'))
  await expect(new DshSessionAdapter(ctx).withAdmission(() => {}).prompt(imageCommand, new AbortController().signal)).rejects.toThrow('invalid PNG')
  expect(invoke).not.toHaveBeenCalled()
})
test('dispatcher snapshots caller Fence and concurrent calls retain individual guards', async () => {
  const { adapter, fence, signal } = fixture(); const held = Promise.withResolvers<void>()
  const observed: (() => void)[] = []
  const callerFence = { ...incoming }
  const handler: NonNullable<import('../src/adapter/types.ts').AdditionalHandlers['interaction.answer']> = async (_command, _signal, admission) => { observed.push(admission); await held.promise; admission(); return true }
  const first = dispatchCommand(adapter, fence, callerFence, { op: 'interaction.answer', deliveryId: 'first', answer: true }, signal, { 'interaction.answer': handler })
  callerFence.authEpoch = 99
  const second = dispatchCommand(adapter, fence, incoming, { op: 'interaction.answer', deliveryId: 'second', answer: true }, signal, { 'interaction.answer': handler })
  held.resolve()
  expect(await Promise.all([first, second])).toEqual([true, true])
  expect(observed[0]).not.toBe(observed[1])
})
test('accepted Agent work survives control observer invalidation without synthetic cancel', async () => {
  const { ctx, invoke } = hostFixture(); const { fence, signal } = fixture()
  invoke.mockImplementation(async () => { fence.invalidate(); return { accepted: true } })
  await expect(dispatchCommand(new DshSessionAdapter(ctx), fence, incoming, { op: 'session.prompt', sessionId: 'a', requestId: 'stable', mode: 'queue', content: [{ kind: 'text', text: 'hi' }] }, signal, {})).rejects.toThrow('STALE_CONTROL')
  expect(ctx.sessionController.cancel).not.toHaveBeenCalled()
  expect(signal.aborted).toBe(false)
})
test('synchronous stop checks current membership before comparing and cancelling', () => {
  const { ctx, setMembership } = imageHostFixture()
  const host = { ...ctx, sessionProjections: { stateOf: () => ({ openTurnStartSeq: 12 }) } } as unknown as Context
  const adapter = new DshSessionAdapter(host).withAdmission(() => {})
  const token = adapter.currentStopToken('a')!
  setMembership([])
  expect(() => adapter.stop('a', token)).toThrow('OUT_OF_SCOPE')
  expect(host.sessionController.cancel).not.toHaveBeenCalled()
})
test('unknown public receipt failure is uncertain and is not resent', async () => {
  const { ctx, invoke } = hostFixture(); const adapter = new DshSessionAdapter(ctx).withAdmission(() => {})
  invoke.mockRejectedValue(new Error('transport failed after acceptance'))
  await expect(adapter.create('w', 'new')).rejects.toThrow('RESULT_UNCERTAIN')
  expect(invoke).toHaveBeenCalledTimes(1)
})
test('base observer token survives guarded dispatch and competing facade stops stay spent', async () => {
  const { ctx } = imageHostFixture()
  const host = { ...ctx, sessionProjections: { stateOf: () => ({ openTurnStartSeq: 0 }) } } as unknown as Context
  const adapter = new DshSessionAdapter(host); const { fence, signal } = fixture()
  const token = adapter.currentStopToken('a')!
  expect(token).toMatch(/^[a-f0-9-]{36}$/)
  const command = { op: 'session.stop', sessionId: 'a', stopToken: token } as const
  expect(await dispatchCommand(adapter, fence, incoming, command, signal, {})).toEqual({ accepted: true })
  await expect(dispatchCommand(adapter, fence, incoming, command, signal, {})).rejects.toThrow('STALE_ACTION')
  expect(host.sessionController.cancel).toHaveBeenCalledExactlyOnceWith({ sessionId: 'a' })
  expect(adapter.currentStopToken('a')).toBeNull()
})
test('idle and missing boundary cannot issue a stop capability', () => {
  const { ctx } = imageHostFixture()
  const host = { ...ctx, sessionProjections: { stateOf: vi.fn(() => ({ openTurnStartSeq: null })) } } as unknown as Context
  const adapter = new DshSessionAdapter(host)
  expect(adapter.currentStopToken('a')).toBeNull()
})
test('receipt lookup and stored-image read failures remain uncertain without resend', async () => {
  const { ctx, invoke, attachments } = imageHostFixture()
  attachments.readFileStream.mockImplementation(async function* () { throw new Error('storage unreachable') })
  await expect(new DshSessionAdapter(ctx).withAdmission(() => {}).prompt(imageCommand, new AbortController().signal)).rejects.toThrow('RESULT_UNCERTAIN')
  expect(invoke).not.toHaveBeenCalled()
})
test('known accepted prompt receipt is preserved when caller cancels after admission', async () => {
  const { ctx, invoke } = hostFixture(); const { fence } = fixture(); const cancel = new AbortController()
  invoke.mockImplementation(async () => { cancel.abort(); return { accepted: true } })
  expect(await dispatchCommand(new DshSessionAdapter(ctx), fence, incoming, { op: 'session.prompt', sessionId: 'a', requestId: 'stable', mode: 'queue', content: [{ kind: 'text', text: 'hi' }] }, cancel.signal, {})).toEqual({ accepted: true })
  expect(ctx.sessionController.cancel).not.toHaveBeenCalled()
})
test('reconciliation cannot resubmit an absent or unreadable outcome, including a recreated adapter', async () => {
  const { ctx, invoke } = hostFixture()
  const command = { ...imageCommand, reconcileOnly: true } as Parameters<SessionAdapter['prompt']>[0]
  await expect(new DshSessionAdapter(ctx).withAdmission(() => {}).prompt(command, new AbortController().signal)).rejects.toThrow('RESULT_UNCERTAIN')
  await expect(new DshSessionAdapter(ctx).withAdmission(() => {}).prompt(command, new AbortController().signal)).rejects.toThrow('RESULT_UNCERTAIN')
  expect(invoke).not.toHaveBeenCalled()
})
test('durable inbox admission proof reconciles before resolving a retired image receipt', async () => {
  const { ctx, invoke } = imageHostFixture()
  const resolve = vi.fn(() => { throw new Error('receipt unavailable') })
  const host = { ...ctx, fileUploads: { resolve }, sessionController: { ...ctx.sessionController, follow: async function* () { yield { type: 'snapshot', cursor: 12, records: [{ type: 'event', event: { type: 'agent/inbox/spliced', seq: 12, data: { inserted: [{ source: { kind: 'user', rpcId: 'stable' } }] } } }], hasMore: false, projections: { values: {} } } } } } as unknown as Context
  expect(await new DshSessionAdapter(host).withAdmission(() => {}).prompt({ ...imageCommand, reconcileOnly: true } as Parameters<SessionAdapter['prompt']>[0], new AbortController().signal)).toEqual({ accepted: true })
  expect(resolve).not.toHaveBeenCalled(); expect(invoke).not.toHaveBeenCalled()
})
test('facade-shared concurrent prompt gate dispatches the same business ID once', async () => {
  const { ctx, invoke, attachments } = imageHostFixture(); const pending = Promise.withResolvers<void>()
  attachments.validateImage.mockImplementation(async () => pending.promise)
  const base = new DshSessionAdapter(ctx)
  const first = base.withAdmission(() => {}).prompt(imageCommand, new AbortController().signal)
  const second = base.withAdmission(() => {}).prompt(imageCommand, new AbortController().signal)
  pending.resolve()
  expect(await Promise.all([first, second])).toEqual([{ accepted: true }, { accepted: true }])
  expect(invoke).toHaveBeenCalledTimes(1)
})
test('reconciliation lookup faults, exhausted history and rotation cannot admit new prompts', async () => {
  const { ctx, invoke } = hostFixture()
  const host = { ...ctx, sessionController: { ...ctx.sessionController, follow: () => { throw new Error('read failure') } } } as unknown as Context
  await expect(new DshSessionAdapter(host).withAdmission(() => {}).prompt({ ...imageCommand, reconcileOnly: true }, new AbortController().signal)).rejects.toThrow('RESULT_UNCERTAIN')
  expect(invoke).not.toHaveBeenCalled()
})
test('older public admission pages reconcile with exact follow cut before image preparation', async () => {
  const { ctx, invoke } = hostFixture()
  const page = vi.fn(async () => ({ records: [{ type: 'event', event: { type: 'user/message', seq: 1, data: { source: { kind: 'user', rpcId: 'stable' } } } }], hasMore: false }))
  const host = { ...ctx, sessionController: { ...ctx.sessionController, follow: async function* () { yield { type: 'snapshot', cursor: 20, records: [{ type: 'event', event: { type: 'turn/end', seq: 10, data: {} } }], hasMore: true, projections: { values: {} } } }, page } } as unknown as Context
  expect(await new DshSessionAdapter(host).withAdmission(() => {}).prompt({ ...imageCommand, reconcileOnly: true }, new AbortController().signal)).toEqual({ accepted: true })
  expect(page).toHaveBeenCalledWith({ address: { kind: 'session', sessionId: 'a' }, throughSeq: 20, beforeSeq: 10, maxMessages: 64 }, expect.any(AbortSignal))
  expect(invoke).not.toHaveBeenCalled()
})
test('unresolved prompt gates are bounded and never evicted to admit another call', async () => {
  const { ctx, invoke } = hostFixture(); const hold = Promise.withResolvers<void>(); const base = new DshSessionAdapter(ctx)
  const host = { ...ctx, sessionController: { ...ctx.sessionController, follow: async function* () { await hold.promise; yield { type: 'snapshot', cursor: 12, records: [], hasMore: false, projections: { values: {} } } } } } as unknown as Context
  const adapter = new DshSessionAdapter(host).withAdmission(() => {})
  const calls = Array.from({ length: 16 }, (_, index) => adapter.prompt({ ...imageCommand, requestId: String(index), content: [{ kind: 'text', text: 'hi' }] }, new AbortController().signal))
  await expect(adapter.prompt({ ...imageCommand, requestId: 'overflow' }, new AbortController().signal)).rejects.toThrow('BACKPRESSURE')
  expect(invoke).not.toHaveBeenCalled()
  hold.resolve(); await Promise.all(calls)
  expect(invoke).toHaveBeenCalledTimes(16)
})
test('joining prompt callers independently recheck their own authority', async () => {
  const { ctx, invoke, attachments } = imageHostFixture(); const hold = Promise.withResolvers<void>(); let joiningAllowed = true
  attachments.validateImage.mockImplementation(async () => hold.promise)
  const base = new DshSessionAdapter(ctx)
  const first = base.withAdmission(() => {}).prompt(imageCommand, new AbortController().signal)
  const joined = base.withAdmission(() => { if (!joiningAllowed) throw new Error('STALE_CONTROL') }).prompt({ ...imageCommand, reconcileOnly: true }, new AbortController().signal)
  joiningAllowed = false; hold.resolve()
  expect(await first).toEqual({ accepted: true })
  await expect(joined).rejects.toThrow('STALE_CONTROL')
  expect(invoke).toHaveBeenCalledTimes(1)
})
test('capped history is uncertain for both reconciliation and fresh same-ID admission', async () => {
  const { ctx, invoke } = hostFixture()
  const page = vi.fn(async (request: { beforeSeq: number }) => ({ records: [{ type: 'event', event: { type: 'turn/end', seq: request.beforeSeq - 1, data: {} } }], hasMore: true }))
  const host = { ...ctx, sessionController: { ...ctx.sessionController, follow: async function* () { yield { type: 'snapshot', cursor: 1000, records: [{ type: 'event', event: { type: 'turn/end', seq: 900, data: {} } }], hasMore: true, projections: { values: {} } } }, page } } as unknown as Context
  const adapter = new DshSessionAdapter(host).withAdmission(() => {})
  await expect(adapter.prompt({ ...imageCommand, reconcileOnly: true }, new AbortController().signal)).rejects.toThrow('RESULT_UNCERTAIN')
  expect(page).toHaveBeenCalledTimes(64)
  await expect(adapter.prompt(imageCommand, new AbortController().signal)).rejects.toThrow('RESULT_UNCERTAIN')
  expect(page).toHaveBeenCalledTimes(128); expect(invoke).not.toHaveBeenCalled()
})
test('rotation across awaited admission lookup prevents new mutation', async () => {
  const { ctx, invoke } = hostFixture(); const { fence, identity, signal } = fixture()
  const host = { ...ctx, sessionController: { ...ctx.sessionController, follow: async function* () { await Promise.resolve(); identity.authEpoch++; yield { type: 'snapshot', cursor: 12, records: [], hasMore: false, projections: { values: {} } } } } } as unknown as Context
  await expect(dispatchCommand(new DshSessionAdapter(host), fence, incoming, imageCommand, signal, {})).rejects.toThrow('AUTH_REVOKED')
  expect(invoke).not.toHaveBeenCalled()
})

test('image binding commits known acceptance before revoked origin guard, preserving authorized joiner', async () => {
  const { ctx, invoke, binding, bindPrompt, agent } = imageHostFixture()
  const ack = Promise.withResolvers<unknown>(); let originAllowed = true
  invoke.mockImplementation(() => ack.promise)
  const base = new DshSessionAdapter(ctx)
  const origin = base.withAdmission(() => { if (!originAllowed) throw new Error('AUTH_REVOKED') }).prompt(imageCommand, new AbortController().signal)
  const rejected = expect(origin).rejects.toThrow('AUTH_REVOKED')
  const joined = base.withAdmission(() => {}).prompt({ ...imageCommand, reconcileOnly: true }, new AbortController().signal)
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1))
  originAllowed = false; ack.resolve({ accepted: true })
  await rejected
  expect(await joined).toEqual({ accepted: true })
  expect(bindPrompt).toHaveBeenCalledExactlyOnceWith(agent, ['receipt'], 'stable')
  expect(binding.commit).toHaveBeenCalledTimes(1)
  expect(binding[Symbol.dispose]).toHaveBeenCalledTimes(1)
  expect(ctx.sessionController.cancel).not.toHaveBeenCalled()
})
test('image binding commits known acceptance despite caller abort after invoke', async () => {
  const { ctx, invoke, binding } = imageHostFixture(); const controller = new AbortController()
  invoke.mockImplementation(async () => { controller.abort(); return { accepted: true } })
  expect(await new DshSessionAdapter(ctx).withAdmission(() => {}).prompt(imageCommand, controller.signal)).toEqual({ accepted: true })
  expect(binding.commit).toHaveBeenCalledTimes(1); expect(binding[Symbol.dispose]).toHaveBeenCalledTimes(1)
  expect(ctx.sessionController.cancel).not.toHaveBeenCalled()
})
test('definite native image rejection rolls back binding while ambiguous intake preserves it', async () => {
  const { ctx, invoke, binding } = imageHostFixture(); const adapter = new DshSessionAdapter(ctx).withAdmission(() => {})
  invoke.mockRejectedValueOnce({ code: 'session/writer-held' })
  await expect(adapter.prompt(imageCommand, new AbortController().signal)).rejects.toThrow('WRITER_HELD')
  expect(binding.commit).not.toHaveBeenCalled(); expect(binding[Symbol.dispose]).toHaveBeenCalledTimes(1)
  invoke.mockRejectedValueOnce(new Error('lost response'))
  await expect(adapter.prompt(imageCommand, new AbortController().signal)).rejects.toThrow('RESULT_UNCERTAIN')
  expect(binding.commit).toHaveBeenCalledTimes(1); expect(binding[Symbol.dispose]).toHaveBeenCalledTimes(2)
  expect(invoke).toHaveBeenCalledTimes(2); expect(ctx.sessionController.cancel).not.toHaveBeenCalled()
})
test('revocation during synchronous image binding rolls it back without public invocation', async () => {
  const { ctx, invoke, binding, bindPrompt } = imageHostFixture(); let allowed = true
  bindPrompt.mockImplementation(() => { allowed = false; return binding })
  await expect(new DshSessionAdapter(ctx).withAdmission(() => { if (!allowed) throw new Error('AUTH_REVOKED') }).prompt(imageCommand, new AbortController().signal)).rejects.toThrow('AUTH_REVOKED')
  expect(invoke).not.toHaveBeenCalled(); expect(binding.commit).not.toHaveBeenCalled(); expect(binding[Symbol.dispose]).toHaveBeenCalledTimes(1)
})

import { HostBudget } from '../src/host-transport.ts'
import { HostOperations } from '../src/host-operations.ts'
// Real dispatcher + adapter, with the same reserve function used by every owner.
function budgetImageFixture(size: number, cap: number) {
  const f = imageHostFixture(Buffer.alloc(size, 7)); const { fence } = fixture()
  f.attachments.imageLimits.maxImageBytes = size; f.attachments.imageLimits.maxMessageImageBytes = size
  const ctx = { ...f.ctx, connection: { createSharedFetchHandler: () => ({ fetch: vi.fn() }) }, typertGateway: { ...f.ctx.typertGateway, stream: async function* ({ signal }: { signal: AbortSignal }) { await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })) } } } as unknown as Context
  const budget = new HostBudget(cap)
  const adapter = new DshSessionAdapter(ctx, undefined, { reserve: budget.reserve })
  const sends: import('../../protocol/src/index.ts').HostMessage[] = []
  const ops = new HostOperations(ctx, adapter, fence, budget.reserve, async message => { sends.push(message) }, vi.fn())
  ops.attach(incoming)
  const call = (id = '44444444-4444-4444-8444-444444444444') => ops.receive({ v: 1, type: 'call', id, fence: incoming, command: { ...imageCommand, requestId: '55555555-5555-4555-8555-555555555555' } })
  return { ...f, budget, adapter, ops, call, sends }
}
test.each([8192, 1300, 650])('aggregate refuses image copy, concatenation or encoding before native admission (%i bytes)', async size => {
  const f = budgetImageFixture(size, 4000); const release = f.budget.reserve(1000)
  try {
    f.call(); await vi.waitFor(() => expect(f.sends).toHaveLength(1))
    expect(f.sends[0]).toMatchObject({ type: 'result', result: { ok: false, error: { code: 'RESYNC_REQUIRED' } } })
    expect(f.invoke).not.toHaveBeenCalled(); expect(f.bindPrompt).not.toHaveBeenCalled()
    expect(f.attachments.validateImage).toHaveBeenCalledTimes(size === 650 ? 1 : 0)
    expect(f.budget.bytes).toBe(1000)
  } finally { release(); await f.ops.dispose() }
})
test('aggregate keeps validated image charged through cancellation and releases only when validation settles', async () => {
  const f = budgetImageFixture(8192, 50000); const release = f.budget.reserve(1000)
  const held = Promise.withResolvers<void>(); f.attachments.validateImage.mockImplementation(() => held.promise)
  try {
    f.call(); await vi.waitFor(() => expect(f.attachments.validateImage).toHaveBeenCalledTimes(1))
    expect(f.budget.bytes).toBeGreaterThan(1000 + 8192)
    const retained = f.budget.bytes; f.ops.detach(); expect(f.budget.bytes).toBe(retained)
    held.resolve(); await vi.waitFor(() => expect(f.budget.bytes).toBe(1000))
    expect(f.invoke).not.toHaveBeenCalled(); expect(f.bindPrompt).not.toHaveBeenCalled()
  } finally { held.resolve(); release(); await f.ops.dispose() }
})
test('aggregate retains encoded image through native outcome and shared facade joins without another copy', async () => {
  const f = budgetImageFixture(8192, 50000); const held = Promise.withResolvers<unknown>(); f.invoke.mockImplementation(() => held.promise)
  try {
    f.call(); await vi.waitFor(() => expect(f.invoke).toHaveBeenCalledTimes(1))
    expect(f.budget.bytes).toBeGreaterThan(2 * 4 * Math.ceil(8192 / 3))
    const joined = f.adapter.withAdmission(() => {}).prompt({ ...imageCommand, requestId: '55555555-5555-4555-8555-555555555555' }, new AbortController().signal)
    expect(f.attachments.readFileStream).toHaveBeenCalledTimes(1)
    f.ops.detach(); expect(f.budget.bytes).toBeGreaterThan(20000)
    held.resolve({ accepted: true }); expect(await joined).toEqual({ accepted: true })
    await vi.waitFor(() => expect(f.budget.bytes).toBe(0))
    expect(f.binding.commit).toHaveBeenCalledTimes(1); expect(f.binding[Symbol.dispose]).toHaveBeenCalledTimes(1)
  } finally { held.resolve({ accepted: true }); await f.ops.dispose() }
})

test.each(['validation', 'WRITER_HELD', 'RESULT_UNCERTAIN'])('aggregate releases image ownership on %s failure with correct receipt bookkeeping', async failure => {
  const f = budgetImageFixture(8192, 50000)
  if (failure === 'validation') f.attachments.validateImage.mockRejectedValueOnce(new Error('invalid image'))
  else f.invoke.mockRejectedValueOnce(failure === 'WRITER_HELD' ? { code: 'session/writer-held' } : new Error('unknown admission outcome'))
  try {
    f.call(); await vi.waitFor(() => expect(f.sends).toHaveLength(1))
    expect(f.budget.bytes).toBe(0)
    expect(f.bindPrompt).toHaveBeenCalledTimes(failure === 'validation' ? 0 : 1)
    expect(f.binding.commit).toHaveBeenCalledTimes(failure === 'RESULT_UNCERTAIN' ? 1 : 0)
    expect(f.binding[Symbol.dispose]).toHaveBeenCalledTimes(failure === 'validation' ? 0 : 1)
  } finally { await f.ops.dispose() }
})

test('native rich page keeps the original history cut and returns a smaller exact contiguous page', async () => {
  const records = Array.from({ length: 100 }, (_, seq) => ({ type: 'event', event: { type: seq % 5 === 0 ? 'user/message' : 'tool/result', seq, time: seq, data: { text: 'x'.repeat(4000) } } }))
  const requests: any[] = []
  const ctx = { workspaceRegistry: { list: () => [{ id: 'w', sessionIds: ['a'] }] }, typertGateway: { invoke: async ({ args }: any) => { requests.push(args.request); const count = args.request.maxMessages; return Object.assign(Object.create(null), { records: records.slice(Math.max(0, 100 - count * 5)), hasMore: count * 5 < 100 }) } } } as unknown as Context
  const adapter = new DshSessionAdapter(ctx).withAdmission(() => {})
  const value = await adapter.page({ op: 'session.page', sessionId: 'a', throughSeq: 120, beforeSeq: 100, maxMessages: 64 }, new AbortController().signal)
  expect(value).toEqual({ records: records.slice(60), hasMore: true })
  expect(requests.every(request => request.throughSeq === 120 && request.beforeSeq === 100)).toBe(true)
  expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThan(256 * 1024 - 1024)
})

test('native page rejects accessors and arbitrary prototypes without executing them or retrying', async () => {
  let invoked = 0, reads = 0
  const ctx = { workspaceRegistry: { list: () => [{ id: 'w', sessionIds: ['a'] }] }, typertGateway: { invoke: async () => { reads++; return Object.defineProperty({}, 'records', { enumerable: true, get() { invoked++; return [] } }) } } } as unknown as Context
  const adapter = new DshSessionAdapter(ctx).withAdmission(() => {})
  await expect(adapter.page({ op: 'session.page', sessionId: 'a', throughSeq: 1, maxMessages: 64 }, new AbortController().signal)).rejects.toThrow('INVALID_MESSAGE')
  expect(invoked).toBe(0); expect(reads).toBe(1)
  ctx.typertGateway.invoke = (async () => Object.create({ records: [] })) as any
  await expect(adapter.page({ op: 'session.page', sessionId: 'a', throughSeq: 1, maxMessages: 64 }, new AbortController().signal)).rejects.toThrow('INVALID_MESSAGE')
})
test('page cancellation prevents a smaller read and propagates the original reason', async () => {
  const control = new AbortController(); let reads = 0
  const ctx = { workspaceRegistry: { list: () => [{ id: 'w', sessionIds: ['a'] }] }, typertGateway: { invoke: async () => { reads++; control.abort(new Error('owned read cancelled')); return { records: [{ text: 'x'.repeat(300000) }], hasMore: true } } } } as unknown as Context
  await expect(new DshSessionAdapter(ctx).withAdmission(() => {}).page({ op: 'session.page', sessionId: 'a', throughSeq: 1, maxMessages: 64 }, control.signal)).rejects.toThrow('owned read cancelled')
  expect(reads).toBe(1)
})
test('ui.read dispatch requires a closed handler and fences replies after preparation', async () => {
  const { adapter, fence, identity, signal } = fixture()
  const command = { op: 'ui.read', view: 'host-facts' } as const
  await expect(dispatchCommand(adapter, fence, incoming, command, signal, {})).rejects.toThrow('PROTOCOL_UNSUPPORTED')
  await expect(dispatchCommand(adapter, fence, incoming, command, signal, {
    'ui.read': async (received, linked, admission) => {
      expect(received).toEqual(command); expect(linked).toBe(signal); admission()
      await Promise.resolve(); identity.authEpoch++; return { home: '/test' }
    },
  })).rejects.toThrow('AUTH_REVOKED')
})
test('native page forwards turn-window bounds while preserving its immutable history cut', async () => {
  const { ctx, invoke } = hostFixture(); invoke.mockResolvedValue({ records: [], hasMore: false })
  const adapter = new DshSessionAdapter(ctx).withAdmission(() => {})
  await adapter.page({ op: 'session.page', sessionId: 'a', throughSeq: 120, beforeSeq: 100, maxMessages: 128, turnWindow: { minMessages: 100, minTurns: 2 } }, new AbortController().signal)
  expect(invoke.mock.calls[0][0].args.request).toEqual({ address: { kind: 'session', sessionId: 'a' }, throughSeq: 120, beforeSeq: 100, maxMessages: 64, turnWindow: { minMessages: 64, minTurns: 2 } })
})
