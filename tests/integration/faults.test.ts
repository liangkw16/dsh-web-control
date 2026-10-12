import { afterEach, expect, test, vi } from 'vitest'
import { systemFixture, prompt } from '../support/host-driver.ts'
let owned: Awaited<ReturnType<typeof systemFixture>> | undefined
afterEach(async () => { await owned?.close(); owned = undefined })
async function sendTestPrompt(): Promise<string> { const command = prompt(); await owned!.browser.transport.call(command); return command.requestId }
test.each(['browser disconnect', 'host WSS disconnect', 'host restart', 'relay restart', 'plugin uninstall'] as const)('%s preserves accepted work and query-only retry never resubmits', async action => {
  const f = owned = await systemFixture(), requestId = await sendTestPrompt(), old = f.browser.transport.getSnapshot().fence!
  expect(f.host.running('a')).toBe(true); const before = f.host.steps.get('a') ?? 0
  if (action === 'browser disconnect') f.browser.disconnect()
  if (action === 'host WSS disconnect') f.host.disconnect()
  if (action === 'host restart') await f.host.restart()
  if (action === 'relay restart') { await f.relay.restart(); await f.host.reconnect() }
  if (action === 'plugin uninstall') { await f.host.quit(); await vi.waitFor(() => expect(f.host.steps.get('a') ?? 0).toBeGreaterThan(before)); expect(f.host.running('a')).toBe(true); await f.host.start() }
  await vi.waitFor(() => expect(f.browser.transport.getSnapshot().phase).not.toBe('ready'))
  if (action === 'host WSS disconnect') await f.host.reconnect()
  await vi.waitFor(async () => { await f.browser.connect() })
  expect(f.browser.transport.getSnapshot().fence!.controlId).not.toBe(old.controlId)
  await f.browser.transport.call({ ...prompt(requestId), reconcileOnly: true })
  expect(f.host.acceptedPrompts()).toEqual([requestId]); await vi.waitFor(() => expect(f.host.steps.get('a') ?? 0).toBeGreaterThan(before)); expect(f.host.running('a')).toBe(true); expect(f.host.nativeCancels).toBe(0)
})
test('lost mutation receipt reconciles accepted journal after disconnect without another native intake', async () => {
  const f = owned = await systemFixture(), held = Promise.withResolvers<void>(), command = prompt(); f.host.promptWait = held.promise
  const pending = f.browser.transport.call(command); void pending.catch(() => {})
  await vi.waitFor(() => expect(f.host.acceptedPrompts()).toEqual([command.requestId])); f.browser.disconnect()
  await expect(pending).rejects.toThrow('RESULT_UNCERTAIN'); held.resolve(); await f.browser.connect()
  await f.browser.transport.call({ ...command, reconcileOnly: true }); expect(f.host.acceptedPrompts()).toEqual([command.requestId])
  await expect(f.browser.transport.call({ ...prompt(), reconcileOnly: true })).rejects.toThrow('RESULT_UNCERTAIN')
  expect(f.host.acceptedPrompts()).toHaveLength(1)
})
test('same create ID yields exactly one session and workspace deletion rejects new intake', async () => {
  const f = owned = await systemFixture()
  await Promise.all([0, 1].map(() => f.browser.transport.call({ op: 'session.create', workspaceId: 'w', sessionId: 'created' })))
  expect([...f.host.records.keys()].filter(id => id === 'created')).toHaveLength(1)
  f.host.deleteWorkspace(); await expect(f.browser.transport.call(prompt())).rejects.toThrow('OUT_OF_SCOPE'); expect(f.host.acceptedPrompts()).toHaveLength(0)
})

test('autonomous upload timeout releases production transfer while unrelated accepted work continues', async () => {
  const f = owned = await systemFixture({ ...((await import('../../packages/protocol/src/index.ts')).DEFAULT_LIMITS), transferIdleMs: 100 }), deferred = Promise.withResolvers<ArrayBuffer>()
  await f.browser.transport.call(prompt())
  const file = { name: 'delayed.bin', size: 1, type: 'application/octet-stream', slice: () => ({ arrayBuffer: () => deferred.promise }) } as unknown as File
  const upload = f.browser.transport.upload('a', file, new AbortController().signal); void upload.catch(() => {})
  await vi.waitFor(() => expect(f.host.nativeUploads).toBe(1))
  await vi.waitFor(() => expect(f.host.nativeUploads).toBe(0), { timeout: 2000 })
  deferred.resolve(new ArrayBuffer(1)); await expect(upload).rejects.toThrow('TRANSFER_TIMEOUT')
  expect(f.host.running('a')).toBe(true); expect(f.host.nativeCancels).toBe(0)
  await f.browser.transport.call({ op: 'session.list', workspaceId: 'w' })
})

test('dropped rotation ACK prevents link publication; latest durable epoch reconnects', async () => {
  const f = owned = await systemFixture(), old = (await f.host.identity.load())!
  f.relay.dropNextAck(); await expect(f.host.lifecycle.rotate()).rejects.toThrow('HOST_OFFLINE'); expect(f.host.lifecycle.link()).toBeNull()
  expect((await f.host.identity.load())!.authEpoch).toBe(old.authEpoch + 1)
  await f.host.reconnect(); expect(f.host.lifecycle.status().phase).toBe('ready'); expect(f.host.lifecycle.link()).not.toContain(old.linkSecret)
}, 15000)

test('empty upload drains one terminal without closing unrelated calls', async () => {
  const f = owned = await systemFixture()
  const value = await f.browser.transport.upload('a', new File([], 'empty.bin'), new AbortController().signal).catch(error => { throw new Error(`${error.code}: ${f.relay.faults.join(',')}`) })
  expect(value).toMatchObject({ receiptId: 'receipt-a' }); expect(f.relay.faults).toEqual([])
  await f.browser.transport.call({ op: 'session.list', workspaceId: 'w' })
})

test('lower upload cap on actual WSS reconnect retains cancelled unresolved native permits', async () => {
  const f = owned = await systemFixture(), held = Promise.withResolvers<void>()
  f.host.uploadWait = held.promise
  const uploads = [0, 1].map(i => f.browser.transport.upload('a', new File([new Uint8Array([i])], `held-${i}.bin`), new AbortController().signal))
  uploads.forEach(p => void p.catch(() => {}))
  await vi.waitFor(() => expect(f.host.nativeUploads).toBe(2))
  f.host.disconnect()
  await vi.waitFor(() => expect(f.relay.metrics().activeTransfers).toBe(0))
  f.relay.limits.uploads = 1
  await f.relay.restart(); await f.host.reconnect(); await f.browser.connect()
  expect((f.browser.transport as unknown as { limits: { uploads: number } }).limits.uploads).toBe(1)
  await expect(f.browser.transport.upload('a', new File(['x'], 'blocked.bin'), new AbortController().signal)).rejects.toThrow('BACKPRESSURE')
  expect(f.host.nativeUploads).toBe(2)
  held.resolve(); await Promise.allSettled(uploads)
  await vi.waitFor(() => expect(f.host.nativeUploads).toBe(0))
  f.host.uploadWait = undefined
  await expect(f.browser.transport.upload('a', new File(['x'], 'new.bin'), new AbortController().signal)).resolves.toMatchObject({ receiptId: 'receipt-a' })
})
