import type { Context } from '@deepseek-ai/cordis'
import { expect, test, vi } from 'vitest'
import { dispatchCommand } from '../src/commands.ts'
import type { SessionAdapter } from '../src/adapter/types.ts'
import { UploadManager } from '../src/uploads.ts'
import { HostFence } from '../src/control-fence.ts'
import { SessionScope } from '../src/adapter/scope.ts'
import { DEFAULT_LIMITS, BoundedQueue } from '../../protocol/src/index.ts'
const incoming = { instanceId: '11111111-1111-4111-8111-111111111111', runtimeId: '22222222-2222-4222-8222-222222222222', controlId: '33333333-3333-4333-8333-333333333333', authEpoch: 1 }
const id = '44444444-4444-4444-8444-444444444444'
function fixture(consume = true) {
  let selected = ['a']; let reserved = 0; let peak = 0
  const durable = Promise.withResolvers<void>(); const received: Uint8Array[] = []
  const identity = { instanceId: incoming.instanceId, authEpoch: 1, enabled: true, relayOrigin: 'https://relay.test', deviceSecret: Buffer.alloc(32, 1).toString('base64url'), linkSecret: Buffer.alloc(32, 2).toString('base64url') }
  const fence = new HostFence(incoming.instanceId, incoming.runtimeId, () => identity); fence.install(incoming)
  const agent = {}; let receiver: unknown = agent; const file = { attachmentId: 'attachment', name: 'host-name', mediaType: 'application/octet-stream', bytes: 4 }; const receipt = { receiptId: 'receipt', file }
  const uploadStream = vi.fn(async ({ data, signal }: { data: AsyncIterable<Uint8Array>; signal: AbortSignal }) => {
    if (consume) for await (const chunk of data) received.push(chunk)
    await durable.promise; signal.throwIfAborted(); return receipt
  })
  const ctx = { fileUploads: { uploadStream, resolve: (receiver: unknown) => receiver === agent ? file : undefined }, agents: { get: () => receiver } } as unknown as Context
  const credit = vi.fn(); const failed = vi.fn()
  const manager = new UploadManager(ctx, fence, new SessionScope(() => [{ workspaceId: 'w', sessionIds: selected }]), {
    credit, failed, reserve(bytes: number) { reserved += bytes; peak = Math.max(peak, reserved); return () => { reserved -= bytes } },
  })
  return { setReceiver: (value: unknown) => { receiver = value }, manager, credit, failed, fence, identity, durable, received, uploadStream, file, setSelected: (value: string[]) => { selected = value }, get reserved() { return reserved }, get peak() { return peak } }
}
const request = { sessionId: 'a', name: 'browser-name', mediaType: 'image/png', bytes: 4 }
test('completion waits for durable public receipt and preserves Host metadata', async () => {
  const f = fixture(); f.manager.open(id, incoming, request)
  await f.manager.chunk(id, 0, new Uint8Array([1, 2, 3, 4]))
  const finished = f.manager.end(id, 1); let done = false; void finished.then(() => { done = true })
  await Promise.resolve(); expect(done).toBe(false)
  f.durable.resolve(); expect(await finished).toEqual({ receiptId: 'receipt', file: f.file })
  expect(f.received).toEqual([new Uint8Array([1, 2, 3, 4])]); expect(f.reserved).toBe(0)
  expect(f.uploadStream.mock.calls[0][0]).not.toHaveProperty('mediaType'); f.manager.dispose()
})
test.each([1, 0])('rejects wrong or duplicate chunk index %s', async index => {
  const f = fixture(false); f.manager.open(id, incoming, request)
  if (index === 0) await f.manager.chunk(id, 0, new Uint8Array([1]))
  await expect(f.manager.chunk(id, index, new Uint8Array([1]))).rejects.toThrow('Non-contiguous')
  expect(f.reserved).toBe(0); f.durable.resolve(); f.manager.dispose()
})
test('rejects declared/actual excess, incomplete end and unsolicited fifth chunk', async () => {
  const f = fixture(false)
  expect(() => f.manager.open(id, incoming, { ...request, bytes: DEFAULT_LIMITS.fileBytes + 1 })).toThrow()
  f.manager.open(id, incoming, request)
  for (let i = 0; i < 4; i++) await f.manager.chunk(id, i, new Uint8Array([1]))
  await expect(f.manager.chunk(id, 4, new Uint8Array([1]))).rejects.toThrow()
  expect(f.reserved).toBe(0); f.durable.resolve(); f.manager.dispose()
  const g = fixture(); g.manager.open(id, incoming, request)
  await expect(g.manager.end(id, 0)).rejects.toThrow('count'); expect(g.reserved).toBe(0); g.durable.resolve(); g.manager.dispose()
})
test('credit replenishes after Host consumption, not socket receipt', async () => {
  const f = fixture(false); f.manager.open(id, incoming, request)
  expect(f.credit).toHaveBeenCalledTimes(1)
  await f.manager.chunk(id, 0, new Uint8Array([1])); expect(f.credit).toHaveBeenCalledTimes(1)
  f.manager.cancel(id); expect(f.reserved).toBe(0); f.durable.resolve(); f.manager.dispose()
})
test('generation invalidation releases quiet upload buffers synchronously', async () => {
  const f = fixture(false); f.manager.open(id, incoming, request); await f.manager.chunk(id, 0, new Uint8Array([1]))
  expect(f.reserved).toBeGreaterThan(0); f.fence.invalidate(); expect(f.reserved).toBe(0)
  await expect(f.manager.chunk(id, 1, new Uint8Array([1]))).rejects.toThrow(); f.durable.resolve(); f.manager.dispose()
})
test('latest membership checked before bytes and durable return', async () => {
  const f = fixture(); f.manager.open(id, incoming, request); await f.manager.chunk(id, 0, new Uint8Array(4)); const end = f.manager.end(id, 1)
  f.setSelected([]); f.durable.resolve(); await expect(end).rejects.toThrow('OUT_OF_SCOPE'); expect(f.reserved).toBe(0); f.manager.dispose()
})
test('foreign receipt under current receiving Agent is rejected', async () => {
  const f = fixture(); f.manager.open(id, incoming, request); await f.manager.chunk(id, 0, new Uint8Array(4))
  const finished = f.manager.end(id, 1); f.setReceiver({}); f.durable.resolve()
  await expect(finished).rejects.toThrow('OUT_OF_SCOPE'); f.manager.dispose()
})
test('quiet workspace removal cancels owned transfer and result wait', async () => {
  const f = fixture(); f.manager.open(id, incoming, request); await f.manager.chunk(id, 0, new Uint8Array(4))
  const pending = f.manager.end(id, 1); f.setSelected([]); f.manager.scopeChanged()
  await expect(pending).rejects.toThrow('TRANSFER_CLOSED'); expect(f.reserved).toBe(0); f.durable.resolve(); f.manager.dispose()
})
test('32 MiB slow Host intake stays bounded and permits independent approval/stop ordering', async () => {
  const bytes = 32 * 1024 * 1024; const events: string[] = []; let reserved = 0; let peak = 0; let credits = 0
  const identity = { instanceId: incoming.instanceId, authEpoch: 1, enabled: true, relayOrigin: 'https://relay.test', deviceSecret: Buffer.alloc(32, 1).toString('base64url'), linkSecret: Buffer.alloc(32, 2).toString('base64url') }
  const fence = new HostFence(incoming.instanceId, incoming.runtimeId, () => identity); fence.install(incoming)
  const file = { attachmentId: 'file', name: 'slow', bytes }; const agent = {}; let total = 0
  const ctx = { agents: { get: () => agent }, fileUploads: { resolve: () => file, uploadStream: async ({ data }: { data: AsyncIterable<Uint8Array> }) => {
    for await (const chunk of data) { await new Promise(resolve => setImmediate(resolve)); total += chunk.byteLength }
    events.push('durable'); return { receiptId: 'receipt', file }
  } } } as unknown as Context
  const manager = new UploadManager(ctx, fence, new SessionScope(() => [{ workspaceId: 'w', sessionIds: ['a'] }]), {
    failed: () => {}, credit(_id, _fence, count) { credits += count }, reserve(size) { reserved += size; peak = Math.max(peak, reserved); return () => { reserved -= size } },
  })
  manager.open(id, incoming, { ...request, bytes }); let index = 0
  while (index * 65536 < bytes) {
    if (!credits) { await new Promise(resolve => setImmediate(resolve)); continue }
    credits--; await manager.chunk(id, index++, new Uint8Array(65536))
    if (index === 4) {
      // Synthetic transport scheduling around the actual UploadManager, using shared primitives.
      const queue = new BoundedQueue(DEFAULT_LIMITS.bufferedBytes, 1024)
      queue.enqueue('data', new TextEncoder().encode('data'))
      queue.enqueue('control', new TextEncoder().encode('approval'))
      queue.enqueue('control', new TextEncoder().encode('stop'))
      const adapter: SessionAdapter = { withAdmission: () => adapter, assertSession: async () => {}, list: async () => null, create: async () => null, prompt: async () => null, page: async () => null, currentStopToken: () => 'stop', stop: () => { events.push('stop'); return { accepted: true } } }
      const first = new TextDecoder().decode(queue.take()); expect(first).toBe('approval')
      await dispatchCommand(adapter, fence, incoming, { op: 'interaction.answer', deliveryId: 'approval', answer: 'allowed-once' }, new AbortController().signal, { 'interaction.answer': async (_command, _signal, admission) => { admission(); events.push('approval'); return true } })
      const second = new TextDecoder().decode(queue.take()); expect(second).toBe('stop')
      await dispatchCommand(adapter, fence, incoming, { op: 'session.stop', sessionId: 'a', stopToken: 'stop' }, new AbortController().signal, {})
      expect(new TextDecoder().decode(queue.take())).toBe('data')
    }
  }
  expect(await manager.end(id, index)).toEqual({ receiptId: 'receipt', file }); manager.dispose()
  expect(total).toBe(bytes); expect(reserved).toBe(0); expect(peak).toBeLessThanOrEqual(4 * (65536 + 44))
  expect(events).toEqual(['approval', 'stop', 'durable'])
})
test('idle timeout aborts even when native service has not begun consuming', async () => {
  vi.useFakeTimers()
  const f = fixture(false)
  try {
    f.manager.open(id, incoming, request); await f.manager.chunk(id, 0, new Uint8Array([1]))
    await vi.advanceTimersByTimeAsync(DEFAULT_LIMITS.transferIdleMs)
    expect(f.reserved).toBe(0); expect(f.failed).toHaveBeenCalledTimes(1)
    expect(f.failed.mock.calls[0][2]).toMatchObject({ code: 'TRANSFER_TIMEOUT' })
    await expect(f.manager.chunk(id, 1, new Uint8Array([1]))).rejects.toThrow('TRANSFER_CLOSED')
  } finally { f.durable.resolve(); f.manager.dispose(); vi.useRealTimers() }
})

test('autonomous native rejection notifies once, and throwing sink cannot retain resources', async () => {
  const f = fixture(false); f.failed.mockImplementation(() => { throw new Error('queue full') })
  f.manager.open(id, incoming, request); await f.manager.chunk(id, 0, new Uint8Array([1]))
  f.durable.reject(new Error('native storage failed'))
  await new Promise(resolve => setImmediate(resolve))
  expect(f.failed).toHaveBeenCalledTimes(1); expect(f.reserved).toBe(0); f.manager.dispose()
})
test('end owns native rejection and receipt timeout, suppressing autonomous duplicate terminal', async () => {
  vi.useFakeTimers()
  const f = fixture(); const g = fixture()
  try {
    f.manager.open(id, incoming, request); await f.manager.chunk(id, 0, new Uint8Array(4)); const pending = f.manager.end(id, 1)
    const rejected = expect(pending).rejects.toThrow('RESULT_UNCERTAIN')
    await vi.advanceTimersByTimeAsync(DEFAULT_LIMITS.callTimeoutMs); await rejected
    expect(f.failed).not.toHaveBeenCalled(); expect(f.reserved).toBe(0)
    f.durable.reject(new Error('late native rejection')); await Promise.resolve(); expect(f.failed).not.toHaveBeenCalled()
    g.manager.open(id, incoming, request); await g.manager.chunk(id, 0, new Uint8Array(4)); const ended = g.manager.end(id, 1)
    g.durable.reject(new Error('native failure')); await expect(ended).rejects.toThrow('RESULT_UNCERTAIN'); expect(g.failed).not.toHaveBeenCalled()
  } finally { f.manager.dispose(); g.manager.dispose(); vi.useRealTimers() }
})
test('explicit cancel and generation disposal suppress late native failure terminals', async () => {
  for (const invalidate of [false, true]) {
    const f = fixture(false); f.manager.open(id, incoming, request); await f.manager.chunk(id, 0, new Uint8Array([1]))
    if (invalidate) f.fence.invalidate(); else f.manager.cancel(id)
    f.durable.reject(new Error('late native failure')); await new Promise(resolve => setImmediate(resolve))
    expect(f.failed).not.toHaveBeenCalled(); expect(f.reserved).toBe(0); f.manager.dispose()
  }
})
test('cancelled but unresolved native uploads still consume admission slots', async () => {
  const f = fixture(false)
  const second = '55555555-5555-4555-8555-555555555555'; const third = '66666666-6666-4666-8666-666666666666'
  f.manager.open(id, incoming, request); f.manager.cancel(id)
  f.manager.open(second, incoming, request); f.manager.cancel(second)
  expect(() => f.manager.open(third, incoming, request)).toThrow('BACKPRESSURE')
  f.durable.resolve(); await new Promise(resolve => setImmediate(resolve)); f.manager.dispose()
})
test('zero byte upload completes with zero chunks and no payload', async () => {
  const f = fixture(); f.file.bytes = 0; f.manager.open(id, incoming, { ...request, bytes: 0 })
  const result = f.manager.end(id, 0); f.durable.resolve()
  expect(await result).toEqual({ receiptId: 'receipt', file: f.file }); expect(f.received).toHaveLength(0); f.manager.dispose()
})
test('quiet scope revocation without end emits one autonomous terminal', async () => {
  const f = fixture(false); f.manager.open(id, incoming, request); await f.manager.chunk(id, 0, new Uint8Array([1]))
  f.setSelected([]); f.manager.scopeChanged()
  expect(f.failed).toHaveBeenCalledTimes(1); expect(f.failed.mock.calls[0][2]).toMatchObject({ code: 'OUT_OF_SCOPE' }); expect(f.reserved).toBe(0)
  f.durable.resolve(); await new Promise(resolve => setImmediate(resolve)); expect(f.failed).toHaveBeenCalledTimes(1); f.manager.dispose()
})
test('negotiated limits cannot change live entries and lowered cap retains unresolved old-generation permits', async () => {
  const f = fixture(false); f.manager.open(id, incoming, request)
  expect(() => f.manager.configureLimits({ ...DEFAULT_LIMITS, uploads: 1 })).toThrow('TRANSFER_CLOSED')
  f.fence.invalidate(); f.manager.configureLimits({ ...DEFAULT_LIMITS, uploads: 1 })
  const next = { ...incoming, controlId: '55555555-5555-4555-8555-555555555555' }; f.fence.install(next)
  expect(() => f.manager.open('66666666-6666-4666-8666-666666666666', next, request)).toThrow('BACKPRESSURE')
  expect(f.uploadStream).toHaveBeenCalledTimes(1); f.durable.resolve(); await new Promise(resolve => setImmediate(resolve))
  f.manager.open('77777777-7777-4777-8777-777777777777', next, request)
  expect(f.uploadStream).toHaveBeenCalledTimes(2); f.manager.dispose()
})
test('explicit identity rebind retains unresolved native upload permit across new identity', async () => {
  const f = fixture(false); f.manager.configureLimits({ ...DEFAULT_LIMITS, uploads: 1 }); f.manager.open(id, incoming, request)
  await vi.waitFor(() => expect(f.uploadStream).toHaveBeenCalledTimes(1))
  const next = { ...incoming, instanceId: '55555555-5555-4555-8555-555555555555' }
  f.identity.instanceId = next.instanceId; f.fence.rebind(next.instanceId, next.runtimeId); f.fence.install(next)
  expect(() => f.manager.open('66666666-6666-4666-8666-666666666666', next, request)).toThrow()
  expect(f.uploadStream).toHaveBeenCalledTimes(1); f.durable.resolve(); await new Promise(resolve => setTimeout(resolve, 0)); f.manager.dispose()
})
