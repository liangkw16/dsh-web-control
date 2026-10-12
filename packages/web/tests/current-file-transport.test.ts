import { expect, test, vi } from 'vitest'
import { BrowserTransport, type SyncGeneration } from '../src/transport.ts'
import { DEFAULT_LIMITS, encodeChunk, fragmentJson, RC2_UI_PROFILE, LARGE_JSON_CAPABILITY, CURRENT_FILES_CAPABILITY, type SelectedUiProfile, type Fence } from '../../protocol/src/index.ts'
const instanceId = '11111111-1111-4111-8111-111111111111'
const fence: Fence = { instanceId, runtimeId: '22222222-2222-4222-8222-222222222222', controlId: '33333333-3333-4333-8333-333333333333', authEpoch: 1 }
class Socket extends EventTarget {
  readyState = 0; binaryType = ''; bufferedAmount = 0; sent: any[] = []
  send(value: string | Uint8Array) { this.sent.push(typeof value === 'string' ? JSON.parse(value) : value) }
  close() { this.readyState = 3 }
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')) }
  message(value: unknown) { this.dispatchEvent(new MessageEvent('message', { data: value instanceof Uint8Array ? value.buffer : JSON.stringify(value) })) }
  closed(reason = '') { this.readyState = 3; this.dispatchEvent(Object.assign(new Event('close'), { code: 1006, reason })) }
}
function fixture(uiProfile?: SelectedUiProfile) {
  const sockets: Socket[] = []; const storage = new Map<string,string>()
  const transport = new BrowserTransport({ uiProfile, origin: 'https://relay.test', reconnect: false, fetch: vi.fn(async () => Response.json({ hostOnline: true, remoteConnected: false })), socket: () => { const socket = new Socket(); sockets.push(socket); return socket as unknown as WebSocket }, storage: { getItem: k => storage.get(k) ?? null, setItem: (k,v) => { storage.set(k,v) } } as Storage })
  let context: SyncGeneration | undefined
  transport.registerSynchronizer(value => { context = value })
  const connect = async () => { const ready = transport.connect(instanceId); void ready.catch(() => {}); await flush(); const socket = sockets.at(-1)!; socket.open(); return { ready, socket } }
  const attach = (socket: Socket, incoming = fence) => {
    socket.message({ v: 1, type: 'relay.config', limits: DEFAULT_LIMITS, heartbeatMs: 10_000, leaseTtlMs: 30_000 })
    socket.message({ v: 1, type: 'browser.lease', id: '44444444-4444-4444-8444-444444444444', resumeSecret: 'A'.repeat(43), fence: incoming, expiresAt: Date.now() + 30_000 })
    socket.message({ v: 1, type: 'ready', fence: incoming, ...(uiProfile ? { uiProfile } : {}) })
  }
  return { transport, sockets, storage, connect, attach, context: () => context }
}
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }

const profile: SelectedUiProfile = { host: { ...RC2_UI_PROFILE, capabilities: [...RC2_UI_PROFILE.capabilities, CURRENT_FILES_CAPABILITY, LARGE_JSON_CAPABILITY] }, runtimeId: fence.runtimeId, uiRevision: 'a'.repeat(64) }
async function connected() { const f = fixture(profile), { socket, ready } = await f.connect(); f.attach(socket); f.context()!.barrier.ready(); await ready; return { ...f, socket } }
function result(socket: Socket, id: string, value: unknown) { socket.message({ v: 1, type: 'result', id, fence, result: { ok: true, value } }) }
function body(socket: Socket, call: any, bytes: Uint8Array, eof = true) {
  const id = crypto.randomUUID()
  result(socket, call.id, { transferId: id, name: 'file.bin', mediaType: 'application/octet-stream', offset: call.command.offset, bytes: bytes.length, eof })
  let index = 0
  for (let offset = 0; offset < bytes.length; offset += 65536) {
    // Return a task for multi-chunk tests, allowing receiver consumption/credit.
    socket.message(encodeChunk(id, fence.controlId, index++, bytes.slice(offset, offset + 65536)))
  }
  socket.message({ v: 1, type: 'download.end', id, fence, chunks: index })
}
test('native range forwards the exact version and empty native files complete', async () => {
  const f = await connected()
  try {
    const pending = f.transport.readFileRange({ sessionId: 's', path: 'file.bin', version: 'v1', offset: 10, length: 3 }, new AbortController().signal)
    const call = f.socket.sent.findLast(m => m.type === 'call'); expect(call.command.version).toBe('v1'); body(f.socket, call, new Uint8Array([0, 255, 5]))
    expect(new Uint8Array(await (await pending).blob.arrayBuffer())).toEqual(new Uint8Array([0, 255, 5]))
    const download = f.transport.download('s', 'file.bin', new AbortController().signal)
    const stat = f.socket.sent.findLast(m => m.type === 'call'); expect(stat.command.op).toBe('file.stat')
    result(f.socket, stat.id, { ok: true, value: { absolutePath: '/w/file.bin', relativePath: 'file.bin', version: 'empty-v', bytes: 0 } }); await flush()
    const empty = f.socket.sent.findLast(m => m.type === 'call'); expect(empty.command).toMatchObject({ version: 'empty-v', length: 0 }); body(f.socket, empty, new Uint8Array())
    expect((await download).blob.size).toBe(0)
  } finally { f.transport.dispose() }
})
test('a final range inconsistent with the stat size never produces a download Blob', async () => {
  const f = await connected()
  try {
    const pending = f.transport.download('s', 'file.bin', new AbortController().signal), rejected = expect(pending).rejects.toThrow('INVALID_MESSAGE')
    result(f.socket, f.socket.sent.findLast(m => m.type === 'call').id, { ok: true, value: { absolutePath: '/w/file.bin', relativePath: 'file.bin', version: 'v', bytes: 4 } }); await flush()
    body(f.socket, f.socket.sent.findLast(m => m.type === 'call'), new Uint8Array([1,2,3]))
    await rejected; expect(f.transport.getSnapshot().phase).toBe('ready')
  } finally { f.transport.dispose() }
})
test('a changed version fails before opening any range and leaves sessions connected', async () => {
  const f = await connected()
  try {
    const pending = f.transport.download('s', 'file.bin', new AbortController().signal, 'old'), rejected = expect(pending).rejects.toThrow('TRANSFER_CLOSED')
    result(f.socket, f.socket.sent.findLast(m => m.type === 'call').id, { ok: true, value: { absolutePath: '/w/file.bin', relativePath: 'file.bin', version: 'new', bytes: 4 } })
    await rejected; expect(f.socket.sent.filter(m => m.command?.op === 'file.read')).toHaveLength(0); expect(f.transport.getSnapshot().phase).toBe('ready')
  } finally { f.transport.dispose() }
})
test('cancel while a native opener is pending retires its late transfer without receiving bytes', async () => {
  const f = await connected(), abort = new AbortController()
  try {
    const pending = f.transport.readFileRange({ sessionId: 's', path: 'x', version: 'v', offset: 0, length: 3 }, abort.signal), rejected = expect(pending).rejects.toThrow('TRANSFER_CLOSED')
    const call = f.socket.sent.findLast(m => m.type === 'call'); abort.abort(); await rejected
    const id = crypto.randomUUID(); result(f.socket, call.id, { transferId: id, name: 'x', mediaType: 'application/octet-stream', offset: 0, bytes: 3, eof: true }); await flush()
    expect(f.socket.sent.some(m => m.type === 'cancel' && m.id === id)).toBe(true); expect(f.transport.getSnapshot().phase).toBe('ready')
  } finally { f.transport.dispose() }
})
