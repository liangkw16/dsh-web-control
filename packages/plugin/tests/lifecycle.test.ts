import { describe, expect, test, vi } from 'vitest'
import { ControlLifecycle } from '../src/lifecycle.ts'
import { IdentityManager } from '../src/identity.ts'
import { MemoryCredentialStore } from '../src/credential-store.ts'
import type { SessionAdapter } from '../src/adapter/types.ts'
const scope = 'a'.repeat(64)
function fixture() {
  const store = new MemoryCredentialStore(), identity = new IdentityManager(store, scope)
  const relay = { connect: vi.fn().mockResolvedValue(undefined), sync: vi.fn().mockResolvedValue(undefined), close: vi.fn() }
  const adapter = { withAdmission: vi.fn(), assertSession: vi.fn(), list: vi.fn(), create: vi.fn(), prompt: vi.fn(), page: vi.fn(), currentStopToken: vi.fn(), stop: vi.fn() } satisfies SessionAdapter
  return { store, identity, relay, adapter, lifecycle: new ControlLifecycle(identity, relay, adapter) }
}
test('resume uses the saved relay and identity without enrollment or stopping native work', async () => {
  const f = fixture(), enroll = vi.fn()
  const old = await f.identity.enable('https://relay.example')
  await f.lifecycle.start(); await f.lifecycle.stop()
  await f.lifecycle.configure(undefined, undefined, enroll)
  expect(f.lifecycle.status()).toMatchObject({ phase: 'ready', instanceId: old.instanceId })
  expect(await f.identity.load()).toMatchObject({ deviceSecret: old.deviceSecret, enabled: true, relayOrigin: 'https://relay.example' })
  expect(f.lifecycle.link()).toMatch(/^https:\/\/relay.example\/connect\//)
  expect(enroll).not.toHaveBeenCalled(); expect(f.adapter.stop).not.toHaveBeenCalled()
  await f.lifecycle.dispose()
})
describe('persistent lifecycle', () => {
  test('disabled startup does not connect; enabled restart preserves link', async () => {
    const f = fixture(); await f.lifecycle.start(); expect(f.relay.connect).not.toHaveBeenCalled()
    const old = await f.identity.enable('https://relay.example'); await f.lifecycle.start()
    expect(f.lifecycle.status().phase).toBe('ready'); expect(f.lifecycle.link()).toBe(`https://relay.example/connect/${old.instanceId}#key=${old.linkSecret}`)
    await f.lifecycle.dispose(); const next = new ControlLifecycle(f.identity, f.relay, f.adapter); await next.start()
    expect(next.link()).toContain(old.linkSecret); expect(f.adapter.stop).not.toHaveBeenCalled(); await next.dispose()
  })
  test('relay has not acknowledged rotation so link is unavailable', async () => {
    const f = fixture(); await f.identity.enable('https://relay.example'); await f.lifecycle.start()
    f.relay.sync.mockRejectedValue(new Error('DISCONNECTED'))
    await expect(f.lifecycle.rotate()).rejects.toThrow('DISCONNECTED')
    expect(f.lifecycle.link()).toBeNull(); expect(f.lifecycle.status().phase).toBe('syncing'); await f.lifecycle.dispose()
  })
  test('double click rotation shares one durable epoch transition', async () => {
    const f = fixture(); await f.identity.enable('https://relay.example'); await f.lifecycle.start()
    await Promise.all([f.lifecycle.rotate(), f.lifecycle.rotate()]); expect((await f.identity.load())?.authEpoch).toBe(2)
    expect(f.relay.sync).toHaveBeenCalledTimes(1); await f.lifecycle.dispose()
  })
  test('stop is durable offline and disk failure never claims revocation', async () => {
    const f = fixture(); await f.identity.enable('https://relay.example'); await f.lifecycle.start()
    f.store.failNextWrite = true; await expect(f.lifecycle.stop()).rejects.toThrow('WRITE_FAILED')
    expect((await f.identity.load())?.enabled).toBe(true); expect(f.lifecycle.status().phase).toBe('error')
    f.relay.sync.mockRejectedValue(new Error('offline')); await f.lifecycle.stop()
    expect((await f.identity.load())?.enabled).toBe(false); expect(f.lifecycle.status().phase).toBe('disabled'); expect(f.lifecycle.link()).toBeNull()
    expect(f.adapter.stop).not.toHaveBeenCalled(); await f.lifecycle.dispose()
  })
})
test('stop overtakes a slow startup and prevents a late ready state', async () => {
  const f = fixture(); await f.identity.enable('https://relay.example')
  const connecting = Promise.withResolvers<void>(); f.relay.connect.mockReturnValue(connecting.promise)
  const start = f.lifecycle.start(); await vi.waitFor(() => expect(f.relay.connect).toHaveBeenCalled())
  await f.lifecycle.stop(); connecting.resolve(); await start
  expect(f.lifecycle.status().phase).toBe('disabled'); expect(f.lifecycle.link()).toBeNull(); await f.lifecycle.dispose()
})
test('rotate followed by stop cannot let delayed rotation ACK restore ready', async () => {
  const f = fixture(); await f.identity.enable('https://relay.example'); await f.lifecycle.start()
  const ack = Promise.withResolvers<void>(); f.relay.sync.mockImplementationOnce(() => ack.promise)
  const rotating = f.lifecycle.rotate(); await vi.waitFor(() => expect(f.relay.sync).toHaveBeenCalled())
  const stopping = f.lifecycle.stop(); ack.resolve(); await Promise.all([rotating, stopping])
  expect((await f.identity.load())?.enabled).toBe(false); expect(f.lifecycle.status().phase).toBe('disabled'); await f.lifecycle.dispose()
})

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { fixture as relayFixture, enrollmentSecret } from '../../relay/tests/socket-fixture.ts'
import { HostRelayClient, HostBudget, linkVerifier } from '../src/host-transport.ts'
import { DEFAULT_LIMITS, ProtocolError } from '../../protocol/src/index.ts'
function stockContext(): Context {
  return { workspaceRegistry: { list: () => [{ id: 'w', sessionIds: ['a'] }] },
    connection: { createSharedFetchHandler: () => ({ fetch: vi.fn() }) },
    typertGateway: { stream: async ({ signal }: { signal: AbortSignal }) => (async function* () { yield { type: 'baseline', value: { items: [], archivedSessionIds: [], pinnedSessionIds: [] } }; await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }) }) })() },
  } as unknown as Context
}
test('real relay handshake applies configured limits, installs Fence before ready, dispatches and revokes old link', async () => {
  const server = await relayFixture({ limits: { ...DEFAULT_LIMITS, calls: 2 } }); const f = fixture()
  const identity = await f.identity.enable(server.config.publicOrigin)
  const adapter: SessionAdapter = { ...f.adapter, withAdmission: (check: () => void) => ({ ...adapter, list: async () => { check(); return { items: [] } } }) } satisfies SessionAdapter
  const transport = new HostRelayClient(stockContext(), adapter, { isolatedTest: true, origin: server.http() })
  const lifecycle = new ControlLifecycle(f.identity, transport, adapter)
  try {
    await transport.enroll(identity, enrollmentSecret); await lifecycle.start(); expect(lifecycle.link()).toContain(identity.linkSecret)
    const logged = await server.post(`/v1/instances/${identity.instanceId}/login`, { secret: identity.linkSecret })
    expect(logged.status).toBe(200)
    const browser = server.socket(`/v1/instances/${identity.instanceId}/control`, { Cookie: logged.headers.get('set-cookie')!.split(';')[0], Origin: server.config.publicOrigin })
    await browser.open(); browser.send({ v: 1, type: 'browser.hello', versions: [1] })
    expect((await browser.next('relay.config')).limits.calls).toBe(2)
    const lease = await browser.next('browser.lease'); browser.send({ v: 1, type: 'browser.lease-ack', id: lease.id })
    const ready = await browser.next('ready'); expect(ready.fence).toEqual(lease.fence)
    browser.send({ v: 1, type: 'call', id: randomUUID(), fence: ready.fence, command: { op: 'session.list', workspaceId: 'w' } })
    expect((await browser.next('result')).result).toEqual({ ok: true, value: { items: [] } })
    await lifecycle.rotate(); expect(lifecycle.link()).not.toContain(identity.linkSecret)
    expect((await browser.next('fault')).error.code).toBe('AUTH_REVOKED')
    expect((await server.post(`/v1/instances/${identity.instanceId}/login`, { secret: identity.linkSecret })).status).toBe(401)
    await lifecycle.stop(); expect(lifecycle.status().phase).toBe('disabled'); expect(f.adapter.stop).not.toHaveBeenCalled()
  } finally { await lifecycle.dispose(); await server.close() }
})
test('initial saved credentials can recover a lost registration acknowledgment without enrollment', async () => {
  const server = await relayFixture(); const f = fixture(); const identity = await f.identity.enable(server.config.publicOrigin)
  const transport = new HostRelayClient(stockContext(), f.adapter, { isolatedTest: true, origin: server.http() })
  const lifecycle = new ControlLifecycle(f.identity, transport, f.adapter)
  try {
    await server.post('/v1/devices/register', { enrollmentSecret, instanceId: identity.instanceId, deviceSecret: identity.deviceSecret, linkVerifier: linkVerifier(identity), authEpoch: identity.authEpoch })
    await lifecycle.start(); expect(lifecycle.status().phase).toBe('ready'); expect(lifecycle.link()).toContain(identity.linkSecret)
  } finally { await lifecycle.dispose(); await server.close() }
})
test('one aggregate budget charges independent producer ownership and actual socket buffer', () => {
  let socketBytes = 0; const budget = new HostBudget(100, () => socketBytes)
  const stream = budget.reserve(40), upload = budget.reserve(40)
  expect(() => budget.reserve(21)).toThrow('RESYNC_REQUIRED'); socketBytes = 21; expect(() => budget.check()).toThrow('RESYNC_REQUIRED')
  stream(); socketBytes = 0; const interaction = budget.reserveControl(60); expect(budget.bytes).toBe(100)
  stream(); upload(); interaction(); expect(budget.bytes).toBe(0)
})

import { HostOperations } from '../src/host-operations.ts'
import { CurrentFileService } from '../src/current-files/service.ts'
import { openLocalFile } from '../src/current-files/local-reader.ts'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HostFence } from '../src/control-fence.ts'
import type { HostMessage } from '../../protocol/src/index.ts'
function operationFixture(native = false) {
  const f = fixture(); const identity = { instanceId: randomUUID(), deviceSecret: Buffer.alloc(32, 1).toString('base64url'), linkSecret: Buffer.alloc(32, 2).toString('base64url'), authEpoch: 1, enabled: true, relayOrigin: 'https://relay.test' }
  const incoming = { instanceId: identity.instanceId, runtimeId: randomUUID(), controlId: randomUUID(), authEpoch: 1 }
  const fence = new HostFence(identity.instanceId, incoming.runtimeId, () => identity); fence.install(incoming)
  const sends: { message: HostMessage; check: () => void }[] = []
  const adapter: SessionAdapter = { ...f.adapter, withAdmission: check => ({ ...adapter, list: async () => { check(); return [] } }) }
  const ctx = stockContext(); const budget = new HostBudget(); const failed = vi.fn()
  if (native) { Object.assign(ctx, { get: () => Object.fromEntries(['rename', 'delete', 'insertBefore', 'archiveSession', 'unarchiveSession', 'pinSession', 'unpinSession'].map(key => [key, () => {}])), sessionController: { rename() {}, fork() {}, search() {}, list() {} } }); Object.assign(ctx.typertGateway, { invoke: async () => ({}) }) }
  const send = vi.fn(async (message: HostMessage, check: () => void) => { sends.push({ message, check }) })
  const operations = new HostOperations(ctx, adapter, fence, budget.reserve, send, failed)
  operations.attach(incoming)
  return { ...f, adapter, ctx, operations, identity, incoming, fence, sends, send, budget, failed }
}
test('rejected download opener releases its handle without an unknown terminal or broken session', async () => {
  const f = operationFixture(), root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'dsh-opener-')))
  await fs.writeFile(join(root, 'x'), 'body')
  let allowed = true
  const file = await openLocalFile(root, 'x', { signal: new AbortController().signal, maxFileBytes: 1024, maxRangeBytes: 1024, maxTextBytes: 1024 })
  const close = vi.spyOn(file, 'close')
  const open = vi.spyOn(CurrentFileService.prototype, 'open').mockResolvedValue(Object.assign(file, { assertAuthority: () => { if (!allowed) throw new ProtocolError('OUT_OF_SCOPE') } }))
  f.operations.configure({ ...DEFAULT_LIMITS, transferIdleMs: 50 }); f.operations.attach(f.incoming)
  f.send.mockImplementation(async (message, check) => {
    if (message.type === 'result' && message.result.ok && typeof message.result.value === 'object' && message.result.value && 'transferId' in message.result.value) allowed = false
    check(); f.sends.push({ message, check })
  })
  try {
    const id = randomUUID()
    f.operations.receive({ v: 1, type: 'call', id, fence: f.incoming, command: { op: 'file.read', sessionId: 'a', path: 'x', version: file.version, offset: 0, length: 4 } })
    await vi.waitFor(() => expect(f.sends).toHaveLength(1))
    expect(f.sends[0].message).toMatchObject({ type: 'result', id, result: { ok: false, error: { code: 'OUT_OF_SCOPE' } } })
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(close).toHaveBeenCalled(); expect(f.sends).toHaveLength(1)
    expect(f.budget.bytes).toBe(0)
    f.operations.receive({ v: 1, type: 'call', id: randomUUID(), fence: f.incoming, command: { op: 'session.list', workspaceId: 'w' } })
    await vi.waitFor(() => expect(f.sends).toHaveLength(2))
    expect(f.failed).not.toHaveBeenCalled(); expect(f.adapter.stop).not.toHaveBeenCalled()
  } finally { open.mockRestore(); await f.operations.dispose(); await fs.rm(root, { recursive: true, force: true }) }
})
test('queued physical result checks copied current Fence after dispatch completed', async () => {
  const f = operationFixture()
  try {
    f.operations.receive({ v: 1, type: 'call', id: randomUUID(), fence: f.incoming, command: { op: 'session.list', workspaceId: 'w' } })
    await vi.waitFor(() => expect(f.sends.length).toBe(1)); expect(() => f.sends[0].check()).not.toThrow()
    f.fence.invalidate(); expect(() => f.sends[0].check()).toThrow('STALE_CONTROL')
    expect(f.adapter.stop).not.toHaveBeenCalled()
  } finally { f.fence.invalidate(); await f.operations.dispose() }
})
test('autonomous upload failure has one terminal and late end is known, while native permits span reconnect', async () => {
  const f = operationFixture(); const pending = Promise.withResolvers<never>(); const uploadStream = vi.fn(() => pending.promise)
  Object.assign(f.ctx, { fileUploads: { uploadStream }, agents: { get: () => undefined } })
  const request = { v: 1 as const, type: 'upload.open' as const, fence: f.incoming, sessionId: 'a', name: 'test', mediaType: 'text/plain', bytes: 0 }
  try {
    const id = randomUUID(); f.operations.receive({ ...request, id }); pending.reject(new ProtocolError('TRANSFER_TIMEOUT'))
    await vi.waitFor(() => expect(f.sends.filter(item => item.message.type === 'result')).toHaveLength(1))
    f.operations.receive({ v: 1, type: 'upload.end', id, fence: f.incoming, chunks: 0 })
    expect(f.sends.filter(item => item.message.type === 'result')).toHaveLength(1)
    const unsettled = Promise.withResolvers<never>(); uploadStream.mockImplementation(() => unsettled.promise)
    f.operations.receive({ ...request, id: randomUUID() }); f.operations.receive({ ...request, id: randomUUID() })
    f.fence.invalidate(); f.operations.detach(); f.operations.configure({ ...DEFAULT_LIMITS, uploads: 1 })
    const next = { ...f.incoming, controlId: randomUUID() }; f.fence.install(next); f.operations.attach(next)
    f.operations.receive({ ...request, fence: next, id: randomUUID() })
    expect(uploadStream).toHaveBeenCalledTimes(3)
    expect(f.sends.at(-1)?.message).toMatchObject({ type: 'result', result: { ok: false, error: { code: 'BACKPRESSURE' } } })
    unsettled.reject(new ProtocolError('TRANSFER_CLOSED')); await new Promise(resolve => setImmediate(resolve))
  } finally { f.fence.invalidate(); await f.operations.dispose() }
})

test('late rejected sends from a detached generation do not fail its replacement', async () => {
  const f = operationFixture(); const pending = Promise.withResolvers<void>(); f.send.mockImplementationOnce(() => pending.promise)
  try {
    f.operations.receive({ v: 1, type: 'call', id: randomUUID(), fence: f.incoming, command: { op: 'session.list', workspaceId: 'w' } })
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(1))
    f.fence.invalidate(); f.operations.detach(); const next = { ...f.incoming, controlId: randomUUID() }; f.fence.install(next); f.operations.attach(next)
    pending.reject(new ProtocolError('HOST_OFFLINE')); await new Promise(resolve => setImmediate(resolve))
    expect(f.failed).not.toHaveBeenCalled()
  } finally { f.fence.invalidate(); await f.operations.dispose() }
})
test('durable stop preempts a stalled rotation acknowledgment', async () => {
  const f = fixture(); await f.identity.enable('https://relay.example'); await f.lifecycle.start()
  const ack = Promise.withResolvers<void>(); f.relay.sync.mockImplementationOnce(() => ack.promise)
  const rotation = f.lifecycle.rotate(); await vi.waitFor(() => expect(f.relay.sync).toHaveBeenCalledTimes(1))
  const stopping = f.lifecycle.stop()
  try {
    expect(await Promise.race([stopping.then(() => 'stopped'), new Promise(resolve => setTimeout(() => resolve('blocked'), 40))])).toBe('stopped')
    expect((await f.identity.load())?.enabled).toBe(false); expect(f.lifecycle.status().phase).toBe('disabled')
  } finally { ack.resolve(); await Promise.allSettled([rotation, stopping]); await f.lifecycle.dispose() }
})
test('late connect after disposal cannot become ready or reconnect', async () => {
  const f = fixture(); await f.identity.enable('https://relay.example')
  const connected = Promise.withResolvers<void>(); f.relay.connect.mockReturnValueOnce(connected.promise)
  const starting = f.lifecycle.start(); await vi.waitFor(() => expect(f.relay.connect).toHaveBeenCalledTimes(1))
  await f.lifecycle.dispose(); connected.resolve(); await starting
  expect(f.lifecycle.status().phase).toBe('offline'); expect(f.lifecycle.link()).toBeNull()
  expect((await f.identity.load())?.enabled).toBe(true); expect(f.adapter.stop).not.toHaveBeenCalled()
  await expect(f.lifecycle.start()).rejects.toThrow('TRANSFER_CLOSED'); expect(f.relay.connect).toHaveBeenCalledTimes(1)
})
test('startup read begun during a pending durable stop cannot restore its older identity', async () => {
  const f = fixture(); const old = await f.identity.enable('https://relay.example'); await f.lifecycle.start()
  const persist = Promise.withResolvers<void>(), reading = Promise.withResolvers<typeof old | undefined>()
  const originalStop = f.identity.stop.bind(f.identity)
  const stopSpy = vi.spyOn(f.identity, 'stop').mockImplementation(async () => { await persist.promise; return originalStop() })
  const stopping = f.lifecycle.stop(); await vi.waitFor(() => expect(stopSpy).toHaveBeenCalledTimes(1))
  vi.spyOn(f.identity, 'load').mockImplementationOnce(() => reading.promise)
  const starting = f.lifecycle.start(); persist.resolve(); await stopping; reading.resolve(old); await starting
  expect(f.lifecycle.status().phase).toBe('disabled'); expect(f.relay.connect).toHaveBeenCalledTimes(1); await f.lifecycle.dispose()
})

test.each(['rotate', 'stop', 'dispose'] as const)('late rejected startup read cannot disturb completed %s', async action => {
  const f = fixture(); await f.identity.enable('https://relay.example'); await f.lifecycle.start()
  const read = Promise.withResolvers<Awaited<ReturnType<typeof f.identity.load>>>()
  vi.spyOn(f.identity, 'load').mockReturnValueOnce(read.promise)
  const opening = f.lifecycle.start(); const rejected = expect(opening).rejects.toThrow('READ_FAILED')
  await f.lifecycle[action](); const before = f.lifecycle.status(), closes = f.relay.close.mock.calls.length, link = f.lifecycle.link()
  read.reject(new ProtocolError('READ_FAILED')); await rejected
  expect(f.lifecycle.status()).toEqual(before); expect(f.relay.close).toHaveBeenCalledTimes(closes); expect(f.lifecycle.link()).toBe(link)
  await f.lifecycle.dispose()
})
test.each(['rotate', 'stop', 'dispose'] as const)('late rejected connect cannot disturb completed %s or schedule a retry', async action => {
  const f = fixture(); await f.identity.enable('https://relay.example')
  const connection = Promise.withResolvers<void>(); f.relay.connect.mockReturnValueOnce(connection.promise)
  const opening = f.lifecycle.start(); const rejected = expect(opening).rejects.toThrow('HOST_OFFLINE')
  await vi.waitFor(() => expect(f.relay.connect).toHaveBeenCalledTimes(1)); await f.lifecycle[action]()
  const before = f.lifecycle.status(), link = f.lifecycle.link()
  connection.reject(new ProtocolError('HOST_OFFLINE')); await rejected
  expect(f.lifecycle.status()).toEqual(before); expect(f.lifecycle.link()).toBe(link)
  expect((f.lifecycle as unknown as { retry?: unknown }).retry).toBeUndefined(); await f.lifecycle.dispose()
})

test.each([2200, 600])('physical send admits socket overlap before buffering a %i-character result', async length => {
  const f = fixture(); const transport = new HostRelayClient(stockContext(), f.adapter)
  let callback: ((error?: Error) => void) | undefined
  let closed: (() => void) | undefined
  const socket = { readyState: 1, bufferedAmount: 0, once: (_event: string, listener: () => void) => { closed = listener }, terminate: vi.fn(() => { socket.readyState = 3; closed?.() }), send: vi.fn((data: string, done: (error?: Error) => void) => { socket.bufferedAmount += Buffer.byteLength(data) + 14; callback = done }) }
  // Direct transport seam: no network timing assumptions; callback stays delayed.
  const internals = transport as unknown as { socket: typeof socket; sockets: Set<typeof socket>; closed: boolean; send(message: HostMessage, check: () => void): Promise<void> }
  internals.socket = socket; internals.sockets.add(socket); internals.closed = false; transport.budget.configure(4000)
  const release = transport.budget.reserve(1000)
  const fence = { instanceId: randomUUID(), runtimeId: randomUUID(), controlId: randomUUID(), authEpoch: 1 }
  const pending = internals.send({ v: 1, type: 'result', id: randomUUID(), fence, result: { ok: true, value: 'x'.repeat(length) } }, () => {})
  void pending.catch(() => {})
  try {
    expect(transport.budget.bytes).toBeLessThanOrEqual(4000)
    if (length === 2200) { expect(socket.send).not.toHaveBeenCalled(); await expect(pending).rejects.toThrow('RESYNC_REQUIRED') }
    else { expect(socket.send).toHaveBeenCalledTimes(1); expect(transport.budget.bytes).toBeGreaterThan(1000 + socket.bufferedAmount); socket.bufferedAmount = 0; callback!(); await pending; expect(transport.budget.bytes).toBe(1000) }
  } finally { socket.bufferedAmount = 0; callback?.(); await Promise.allSettled([pending]); release(); await transport.dispose() }
})

test('explicit replacement persists fresh identity before enrollment; failure keeps retryable saved identity', async () => {
  const f = fixture(); const old = await f.identity.enable('https://relay.example'); await f.lifecycle.start()
  const enroll = vi.fn(async (next) => { expect(await f.identity.load()).toEqual(next); expect(next.instanceId).not.toBe(old.instanceId); throw new ProtocolError('REGISTRATION_FAILED') })
  await expect(f.lifecycle.replaceRegistration('https://other.example', 'A'.repeat(43), enroll)).rejects.toThrow('REGISTRATION_FAILED')
  const next = (await f.identity.load())!; expect(next.relayOrigin).toBe('https://other.example'); expect(f.lifecycle.link()).toBeNull()
  expect(f.relay.sync).toHaveBeenCalledWith(expect.objectContaining({ instanceId: old.instanceId, enabled: false }))
  await f.lifecycle.start(); expect(f.relay.connect).toHaveBeenLastCalledWith(next, expect.any(String), expect.any(AbortSignal)); expect(f.adapter.stop).not.toHaveBeenCalled(); await f.lifecycle.dispose()
})
test('replacement stop write failure preserves identity and never enrolls', async () => {
  const f = fixture(); const old = await f.identity.enable('https://relay.example'); await f.lifecycle.start(); f.store.failNextWrite = true
  const enroll = vi.fn(); await expect(f.lifecycle.replaceRegistration('https://other.example', 'A'.repeat(43), enroll)).rejects.toThrow('WRITE_FAILED')
  expect(await f.identity.load()).toEqual(old); expect(enroll).not.toHaveBeenCalled(); await f.lifecycle.dispose()
})
test('stop during replacement enrollment commits promptly and stale completion cannot re-enable', async () => {
  const f = fixture(); await f.identity.enable('https://relay.example'); await f.lifecycle.start()
  const gate = Promise.withResolvers<void>(), enroll = vi.fn(() => gate.promise)
  const replacing = f.lifecycle.replaceRegistration('https://other.example', 'A'.repeat(43), enroll); void replacing.catch(() => {})
  await vi.waitFor(() => expect(enroll).toHaveBeenCalled())
  await f.lifecycle.stop(); expect((await f.identity.load())!.enabled).toBe(false)
  gate.resolve(); await expect(replacing).rejects.toThrow('TRANSFER_CLOSED')
  expect(f.lifecycle.status().phase).toBe('disabled'); expect(f.relay.connect).toHaveBeenCalledTimes(1); expect(f.adapter.stop).not.toHaveBeenCalled(); await f.lifecycle.dispose()
})
test('configure retry authenticates saved identity first and concurrent stop wins over enrollment', async () => {
  const f = fixture(); const next = await f.identity.enable('https://relay.example')
  f.relay.connect.mockRejectedValueOnce(new ProtocolError('AUTH_FAILED'))
  const gate = Promise.withResolvers<void>(), enroll = vi.fn(() => gate.promise)
  const configuring = f.lifecycle.configure('https://relay.example', 'A'.repeat(43), enroll); void configuring.catch(() => {})
  await vi.waitFor(() => expect(enroll).toHaveBeenCalledWith(next, 'A'.repeat(43)))
  await f.lifecycle.stop(); gate.resolve(); await expect(configuring).rejects.toThrow('TRANSFER_CLOSED')
  expect((await f.identity.load())!.enabled).toBe(false); expect(f.relay.connect).toHaveBeenCalledTimes(1); await f.lifecycle.dispose()
})

test('replacement fresh-identity write failure leaves old identity durably stopped and never enrolls', async () => {
  const f = fixture(); const old = await f.identity.enable('https://relay.example'); await f.lifecycle.start()
  f.relay.sync.mockImplementationOnce(async () => { f.store.failNextWrite = true })
  const enroll = vi.fn()
  await expect(f.lifecycle.replaceRegistration('https://other.example', 'A'.repeat(43), enroll)).rejects.toThrow('WRITE_FAILED')
  expect(await f.identity.load()).toMatchObject({ instanceId: old.instanceId, enabled: false, authEpoch: old.authEpoch + 1 })
  expect(enroll).not.toHaveBeenCalled(); expect(f.lifecycle.link()).toBeNull(); expect(f.adapter.stop).not.toHaveBeenCalled(); await f.lifecycle.dispose()
})
test.each(['stop', 'dispose'] as const)('%s overtakes old-relay replacement ACK and prevents fresh save/enrollment', async action => {
  const f = fixture(); const old = await f.identity.enable('https://relay.example'); await f.lifecycle.start()
  const gate = Promise.withResolvers<void>(); f.relay.sync.mockReturnValueOnce(gate.promise)
  const enroll = vi.fn(), replacing = f.lifecycle.replaceRegistration('https://other.example', 'A'.repeat(43), enroll); void replacing.catch(() => {})
  await vi.waitFor(() => expect(f.relay.sync).toHaveBeenCalledTimes(1))
  await f.lifecycle[action]()
  expect((await f.identity.load())!.instanceId).toBe(old.instanceId); expect(f.lifecycle.link()).toBeNull()
  gate.resolve(); await expect(replacing).rejects.toThrow('TRANSFER_CLOSED')
  expect(enroll).not.toHaveBeenCalled(); expect((await f.identity.load())!.enabled).toBe(false); expect(f.adapter.stop).not.toHaveBeenCalled(); await f.lifecycle.dispose()
})

function largeCatalog(f: ReturnType<typeof operationFixture>) {
  const value = { items: [{ sessionId: 'a', projections: { progress: '进度🚀'.repeat(40000) } }] }
  Object.assign(f.ctx, { get: () => Object.fromEntries(['rename', 'delete', 'insertBefore', 'archiveSession', 'unarchiveSession', 'pinSession', 'unpinSession'].map(key => [key, () => {}])), sessionController: { rename() {}, fork() {}, search() {}, list: async () => value } })
  Object.assign(f.ctx.typertGateway, { invoke: async () => ({}) })
  return value
}
test('large Host result retains bounded body ownership and sends one physical fragment at a time', async () => {
  const f = operationFixture(); const value = largeCatalog(f); const held = Promise.withResolvers<void>()
  f.send.mockImplementationOnce(async (message, check) => { check(); f.sends.push({ message, check }); await held.promise })
  try {
    f.operations.receive({ v: 1, type: 'call', id: randomUUID(), fence: f.incoming, fragments: true, command: { op: 'ui.catalog' } })
    await vi.waitFor(() => expect(f.sends).toHaveLength(1)); expect(f.sends[0].message.type).toBe('json.fragment')
    expect(f.budget.bytes).toBeGreaterThan(Buffer.byteLength(JSON.stringify(value)))
    expect(f.budget.bytes).toBeLessThan(DEFAULT_LIMITS.bufferedBytes)
    held.resolve(); await vi.waitFor(() => expect(f.budget.bytes).toBe(0))
    const parts = f.sends.map(item => item.message).filter(m => m.type === 'json.fragment')
    expect(parts).toHaveLength(parts[0].parts); expect(JSON.parse(parts.map(part => part.data).join('')).result.value).toEqual(value)
    expect(f.failed).not.toHaveBeenCalled()
  } finally { held.resolve(); f.fence.invalidate(); await f.operations.dispose() }
})
test('takeover between Host fragments stops old dispatch and releases the retained body', async () => {
  const f = operationFixture(); largeCatalog(f); const held = Promise.withResolvers<void>()
  f.send.mockImplementationOnce(async (message, check) => { check(); f.sends.push({ message, check }); await held.promise })
  try {
    f.operations.receive({ v: 1, type: 'call', id: randomUUID(), fence: f.incoming, fragments: true, command: { op: 'ui.catalog' } })
    await vi.waitFor(() => expect(f.sends).toHaveLength(1)); f.fence.invalidate(); f.operations.detach(); held.resolve()
    await vi.waitFor(() => expect(f.budget.bytes).toBe(0)); expect(f.sends).toHaveLength(1); expect(f.adapter.stop).not.toHaveBeenCalled(); expect(f.failed).not.toHaveBeenCalled()
  } finally { held.resolve(); await f.operations.dispose() }
})
test('unopted Host returns the existing bounded read error and never emits fragments', async () => {
  const f = operationFixture(); largeCatalog(f)
  try {
    f.operations.receive({ v: 1, type: 'call', id: randomUUID(), fence: f.incoming, command: { op: 'ui.catalog' } })
    await vi.waitFor(() => expect(f.sends).toHaveLength(1)); expect(f.sends[0].message).toMatchObject({ type: 'result', result: { ok: false, error: { code: 'LIMIT_EXCEEDED' } } })
    expect(f.budget.bytes).toBe(0)
  } finally { f.fence.invalidate(); await f.operations.dispose() }
})
test('concurrent 1.1 MiB native catalog and control baseline share one fragment window within 4 MiB', async () => {
  const f = operationFixture(true); const progress = 'x'.repeat(1150000); const value = { items: [{ sessionId: 'a', projections: { progress } }] }
  Object.assign(f.ctx.sessionController, { list: async () => value })
  const baseline = { type: 'baseline', value: { projections: { a: { asOfSeq: 1, values: { progress } } } } }
  const stream = f.ctx.typertGateway.stream.bind(f.ctx.typertGateway)
  Object.assign(f.ctx.typertGateway, { stream: (request: any) => request.namespace === 'session' ? (async function* () { yield baseline; await new Promise<void>(resolve => request.signal.addEventListener('abort', () => resolve(), { once: true })) })() : stream(request) })
  const held = Promise.withResolvers<void>(); f.send.mockImplementationOnce(async (message, check) => { check(); f.sends.push({ message, check }); await held.promise })
  try {
    f.operations.receive({ v: 1, type: 'call', id: randomUUID(), fence: f.incoming, fragments: true, command: { op: 'ui.catalog' } })
    await vi.waitFor(() => expect(f.sends).toHaveLength(1))
    const watchId = randomUUID(); f.operations.receive({ v: 1, type: 'watch', id: watchId, fence: f.incoming, fragments: true, watch: { topic: 'sessions' } })
    await vi.waitFor(() => expect(f.budget.bytes).toBeGreaterThan(2 * progress.length)); expect(f.budget.bytes).toBeLessThan(DEFAULT_LIMITS.bufferedBytes); expect(f.failed).not.toHaveBeenCalled()
    held.resolve(); await vi.waitFor(() => expect(f.budget.bytes).toBe(0))
    const parts = f.sends.map(s => s.message).filter((m): m is Extract<HostMessage, { type: 'json.fragment' }> => m.type === 'json.fragment' && m.id === watchId)
    expect(parts).toHaveLength(parts[0].parts); expect(JSON.parse(parts.map(p => p.data).join('')).value.value).toEqual(baseline)
    expect(f.failed).not.toHaveBeenCalled(); expect(f.adapter.stop).not.toHaveBeenCalled()
  } finally { held.resolve(); f.fence.invalidate(); await f.operations.dispose() }
})
