import { claimEvidenceDirectory } from '../../scripts/evidence-paths.mjs'
const evidenceDir = claimEvidenceDirectory('system')
import { expect, test } from 'vitest'
import { SubmissionQueue } from '../../packages/web/src/submissions.ts'
import { ProtocolError } from '../../packages/protocol/src/index.ts'
test('terminal submission ownership releases bodies and retains at most 128 query states', async () => {
  const queue = new SubmissionQueue({ call: async () => ({ accepted: true }) })
  let latest = ''
  for (let i = 0; i < 2000; i++) latest = await queue.submit({ sessionId: 'a', mode: 'queue', content: [{ kind: 'text', text: 'body'.repeat(8192) }] })
  const attempts = (queue as unknown as { attempts: Map<string, any> }).attempts
  expect(attempts.size).toBeLessThanOrEqual(128)
  expect([...attempts.values()].some(attempt => attempt.command || attempt.draft)).toBe(false)
  expect(queue.state(latest)).toBe('accepted'); await queue.retry(latest)
})
test('uncertain submission retains query-only identity through 2000 terminal submissions', async () => {
  let uncertain = true; const commands: any[] = []
  const queue = new SubmissionQueue({ call: async command => { commands.push(command); if (uncertain) { uncertain = false; throw new ProtocolError('RESULT_UNCERTAIN') }; return { accepted: true } } })
  const id = await queue.submit({ sessionId: 'a', mode: 'queue', content: [{ kind: 'text', text: 'must reconcile' }] })
  for (let i = 0; i < 2000; i++) await queue.submit({ sessionId: 'a', mode: 'queue', content: [{ kind: 'text', text: 'completed' }] })
  expect(queue.state(id)).toBe('uncertain'); await queue.retry(id); expect(commands.at(-1).reconcileOnly).toBe(true); expect(queue.state(id)).toBe('accepted')
})

test('unresolved admission is bounded without evicting any uncertain query', async () => {
  const queue = new SubmissionQueue({ call: async () => { throw new ProtocolError('RESULT_UNCERTAIN') } })
  const ids: string[] = []
  for (let i = 0; i < 128; i++) ids.push(await queue.submit({ sessionId: 'a', mode: 'queue', content: [{ kind: 'text', text: 'unresolved' }] }))
  await expect(queue.submit({ sessionId: 'a', mode: 'queue', content: [{ kind: 'text', text: 'overflow' }] })).rejects.toThrow('BACKPRESSURE')
  for (const id of ids) expect(queue.state(id)).toBe('uncertain')
})

import { systemFixture, prompt } from '../support/host-driver.ts'
import { DEFAULT_LIMITS } from '../../packages/protocol/src/index.ts'
import { vi } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'

test('production Host chooses queued control before data across simultaneous watches', async () => {
  const f = await systemFixture(), abort = new AbortController(), measurement = f.host.observeSends(100)
  let peak = 0
  const sample = setInterval(() => { peak = Math.max(peak, f.host.transport.budget.bytes) }, 1)
  try {
    const iterators = Array.from({ length: 4 }, () => f.browser.transport.watch({ topic: 'session', sessionId: 'a', maxMessages: 64 }, abort.signal)[Symbol.asyncIterator]())
    const openings = iterators.map(iterator => iterator.next())
    await vi.waitFor(() => expect(measurement.frames.some(frame => frame.type === 'event')).toBe(true))
    await f.browser.transport.call({ op: 'session.list', workspaceId: 'w' }); await Promise.all(openings)
    const types = measurement.frames.map(frame => frame.type), result = types.indexOf('result')
    expect(result).toBe(1); expect(types.slice(result + 1)).toContain('event'); expect(peak).toBeLessThanOrEqual(DEFAULT_LIMITS.bufferedBytes)
    abort.abort(); await Promise.all(iterators.map(iterator => iterator.return?.()))
    await vi.waitFor(() => expect(f.host.observers()).toBe(1)); await vi.waitFor(() => expect(f.host.transport.budget.bytes).toBe(0))
    await mkdir(evidenceDir, { recursive: true }); await writeFile(evidenceDir + '/production-selection.json', JSON.stringify({ callbackFaultDelayMs: 100, peakHostBytes: peak, frames: measurement.frames }, null, 2))
  } finally { clearInterval(sample); abort.abort(); measurement.restore(); await f.close() }
})

test('cancelled unresolved native uploads keep shared Host concurrency permits across reconnect', async () => {
  const f = await systemFixture(), held = Promise.withResolvers<void>(), cancellations = [new AbortController(), new AbortController()]
  f.host.uploadWait = held.promise
  try {
    const uploads = cancellations.map(abort => f.browser.transport.upload('a', new File([], 'zero.bin'), abort.signal)); uploads.forEach(upload => void upload.catch(() => {}))
    await vi.waitFor(() => expect(f.host.nativeUploads).toBe(2)); cancellations.forEach(abort => abort.abort()); await Promise.allSettled(uploads)
    f.browser.disconnect(); await vi.waitFor(() => expect(f.browser.transport.getSnapshot().phase).not.toBe('ready')); await f.browser.connect()
    await expect(f.browser.transport.upload('a', new File([], 'third.bin'), new AbortController().signal)).rejects.toThrow('BACKPRESSURE')
    expect(f.host.nativeUploads).toBe(2); held.resolve(); await vi.waitFor(() => expect(f.host.nativeUploads).toBe(0))
    f.host.uploadWait = undefined; const fourth = await f.browser.transport.upload('a', new File([], 'fourth.bin'), new AbortController().signal).catch(error => { throw new Error(`${error.code}: safe fault codes ${f.relay.faults.join(',')}`) }); expect(fourth).toMatchObject({ receiptId: 'receipt-a' })
    expect(f.host.nativeCancels).toBe(0)
  } finally { held.resolve(); cancellations.forEach(abort => abort.abort()); await f.close() }
})

test('slow browser observer overflow requires resync; recovered 2000-record pages are continuous and unique', async () => {
  const f = await systemFixture(), abort = new AbortController()
  try {
    const iterator = f.browser.transport.watch({ topic: 'session', sessionId: 'a', maxMessages: 64 }, abort.signal)[Symbol.asyncIterator]()
    await iterator.next()
    const records = f.host.records.get('a')!
    for (let seq = 0; seq < 2000; seq++) {
      const record = { type: 'event', event: { type: 'user/message', seq, time: seq + 1, data: { id: `m-${seq}`, role: 'user', content: [{ type: 'text', text: `fixed-${seq}` }], source: { kind: 'user' } }, surfaceOp: 'append' } } as any
      records.push(record); f.host.journal.push(record)
      if (seq < 150) await new Promise(resolve => setTimeout(resolve, 1))
    }
    await vi.waitFor(() => expect(f.browser.transport.getSnapshot().code).toBe('RESYNC_REQUIRED'))
    await expect(iterator.next()).rejects.toThrow('RESYNC_REQUIRED'); abort.abort(); await iterator.return?.(); await f.browser.connect()
    let beforeSeq = 2000; const recovered: number[] = []
    while (beforeSeq > 0) { const page = await f.browser.transport.call({ op: 'session.page', sessionId: 'a', throughSeq: 1999, beforeSeq, maxMessages: 64 }) as any; recovered.unshift(...page.records.map((record: any) => record.event.seq)); beforeSeq = recovered[0] }
    expect(recovered).toEqual(Array.from({ length: 2000 }, (_, i) => i)); expect(new Set(recovered).size).toBe(2000)
  } finally { abort.abort(); await f.close() }
})

test('simultaneous image preparation uses the same production Host budget and releases on scope removal', async () => {
  const f = await systemFixture({ ...DEFAULT_LIMITS, bufferedBytes: 10000 }), held = Promise.withResolvers<void>()
  f.host.imageBytes = new Uint8Array(3000); f.host.imageWait = held.promise
  try {
    const first = f.browser.transport.call({ ...prompt(), content: [{ kind: 'upload', receiptId: 'receipt-a', mediaType: 'image/png', name: 'one.png' }] }); void first.catch(() => {})
    await vi.waitFor(() => expect(f.host.transport.budget.bytes).toBeGreaterThan(3000))
    const before = f.host.transport.budget.bytes
    await expect(f.browser.transport.call({ ...prompt(), content: [{ kind: 'upload', receiptId: 'receipt-a', mediaType: 'image/png', name: 'two.png' }] })).rejects.toThrow('RESYNC_REQUIRED')
    expect(f.host.acceptedPrompts()).toEqual([]); expect(f.host.bindingsCreated).toBe(0); expect(f.host.transport.budget.bytes).toBeGreaterThanOrEqual(before)
    f.host.deleteWorkspace(); held.resolve(); await expect(first).rejects.toThrow('OUT_OF_SCOPE')
    await vi.waitFor(() => expect(f.host.transport.budget.bytes).toBe(0)); expect(f.host.bindingsCreated).toBe(0)
  } finally { held.resolve(); await f.close() }
})

test('known accepted image binding commits despite originating browser loss; reconciliation never rebinds', async () => {
  const f = await systemFixture(), held = Promise.withResolvers<void>(); f.host.promptWait = held.promise
  try {
    const command = { ...prompt(), content: [{ kind: 'upload' as const, receiptId: 'receipt-a', mediaType: 'image/png', name: 'image.png' }] }
    const pending = f.browser.transport.call(command); void pending.catch(() => {})
    await vi.waitFor(() => expect(f.host.acceptedPrompts()).toEqual([command.requestId])); f.browser.disconnect(); await expect(pending).rejects.toThrow('RESULT_UNCERTAIN')
    held.resolve(); await vi.waitFor(() => expect(f.host.bindingsDisposed).toBe(1)); expect(f.host.bindingsCommitted).toBe(1)
    await f.browser.connect(); await f.browser.transport.call({ ...command, reconcileOnly: true }); expect(f.host.bindingsCreated).toBe(1); expect(f.host.acceptedPrompts()).toEqual([command.requestId])
  } finally { held.resolve(); await f.close() }
})

test('watch, pending native upload, image copies and physical sends share one production generation budget', async () => {
  const f = await systemFixture({ ...DEFAULT_LIMITS, bufferedBytes: 12000, chunkBytes: 1024 }), image = Promise.withResolvers<void>(), consume = Promise.withResolvers<void>(), abort = new AbortController(), uploadAbort = new AbortController()
  f.host.imageBytes = new Uint8Array(3000); f.host.imageWait = image.promise; f.host.uploadConsumeWait = consume.promise
  try {
    const iterator = f.browser.transport.watch({ topic: 'session', sessionId: 'a', maxMessages: 64 }, abort.signal)[Symbol.asyncIterator](); await iterator.next()
    const first = f.browser.transport.call({ ...prompt(), content: [{ kind: 'upload', receiptId: 'receipt-a', mediaType: 'image/png', name: 'pending.png' }] }, abort.signal); void first.catch(() => {})
    await vi.waitFor(() => expect(f.host.transport.budget.bytes).toBeGreaterThan(3000))
    const upload = f.browser.transport.upload('a', new File([new Uint8Array(4096)], 'retained.bin'), uploadAbort.signal); void upload.catch(() => {})
    await vi.waitFor(() => expect(f.host.transport.budget.bytes).toBeGreaterThan(7000)); expect(f.host.nativeUploads).toBe(1)
    await expect(f.browser.transport.call({ ...prompt(), content: [{ kind: 'upload', receiptId: 'receipt-a', mediaType: 'image/png', name: 'over-budget.png' }] })).rejects.toThrow('RESYNC_REQUIRED')
    expect(f.host.transport.budget.bytes).toBeLessThanOrEqual(12000); expect(f.host.acceptedPrompts()).toEqual([]); expect(f.host.bindingsCreated).toBe(0)
    abort.abort(); uploadAbort.abort(); image.resolve(); consume.resolve(); await Promise.allSettled([first, upload]); await iterator.return?.()
    await vi.waitFor(() => expect(f.host.transport.budget.bytes).toBe(0)); expect(f.host.nativeCancels).toBe(0)
  } finally { abort.abort(); uploadAbort.abort(); image.resolve(); consume.resolve(); await f.close() }
})
