import { expect, test, vi } from 'vitest'
import { BrowserAuthorization } from '../src/connect.ts'

test('fragment is erased before POST, remains page-local for failed same-page retry', async () => {
  const order: string[] = []; const storage = { setItem: vi.fn() }
  const history = { state: null, replaceState: vi.fn((_s, _t, url) => { order.push('erase'); expect(String(url)).not.toContain('key=') }) }
  const fetch = vi.fn().mockImplementationOnce(async () => { order.push('post'); throw Error('offline') }).mockResolvedValue(new Response('{}'))
  const auth = new BrowserAuthorization({ href: 'https://relay.example/?instance=a#key=link-secret', history, fetch })
  await expect(auth.authorize('11111111-1111-4111-8111-111111111111')).rejects.toThrow('offline')
  await auth.authorize('11111111-1111-4111-8111-111111111111')
  expect(order).toEqual(['erase', 'post']); expect(storage.setItem).not.toHaveBeenCalled()
  expect(fetch.mock.calls[0][1]).toMatchObject({ credentials: 'same-origin', body: JSON.stringify({ secret: 'link-secret' }) })
})

test('expired cookie requires original authorization link; unknown cookie is not called revoked', async () => {
  for (const code of ['AUTH_EXPIRED', 'AUTH_REQUIRED']) {
    const auth = new BrowserAuthorization({ href: 'https://relay.example/#key=old', history: { state: null, replaceState() {} }, fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code } }), { status: 401 })) })
    await expect(auth.authorize('11111111-1111-4111-8111-111111111111')).rejects.toMatchObject({ code })
  }
})

import { BrowserTransport, type SyncGeneration } from '../src/transport.ts'
import { DEFAULT_LIMITS, encodeChunk, fragmentJson, RC2_UI_PROFILE, LARGE_JSON_CAPABILITY, type SelectedUiProfile, type Fence } from '../../protocol/src/index.ts'
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

test('lease persisted before ACK; only matching Host-ready and consumer baseline enable call', async () => {
  const f = fixture(); const { socket, ready } = await f.connect()
  await expect(f.transport.call({ op: 'session.stop', sessionId: 'a', stopToken: 'old' })).rejects.toThrow('HOST_OFFLINE')
  f.attach(socket); expect(f.storage.size).toBe(1); expect(socket.sent[1].type).toBe('browser.lease-ack'); expect(f.transport.getSnapshot().phase).toBe('syncing')
  await expect(f.transport.call({ op: 'session.stop', sessionId: 'a', stopToken: 'old' })).rejects.toThrow('SYNC_REQUIRED')
  f.context()!.barrier.ready(); await ready; expect(f.transport.getSnapshot().phase).toBe('ready'); f.transport.dispose()
})
test('disconnect rejects sent mutation as uncertain and old callbacks cannot ready replacement fence', async () => {
  const f = fixture(); let { socket, ready } = await f.connect(); f.attach(socket); const old = f.context()!; old.barrier.ready(); await ready
  const pending = f.transport.call({ op: 'session.stop', sessionId: 'a', stopToken: 't' }); const assertion = expect(pending).rejects.toThrow('RESULT_UNCERTAIN'); socket.closed(); await assertion
  const next = await f.connect(); socket = next.socket; ready = next.ready; f.attach(socket, { ...fence, controlId: '55555555-5555-4555-8555-555555555555' }); old.barrier.ready(); expect(f.transport.getSnapshot().phase).toBe('syncing'); f.context()!.barrier.ready(); await ready
  expect(socket.sent.filter(m => m.type === 'call')).toHaveLength(0); f.transport.dispose()
})
test('download creates Blob only after ordered exact range end; unsupported current source stays explicit', async () => {
  const f = fixture(); const { socket, ready } = await f.connect(); f.attach(socket); f.context()!.barrier.ready(); await ready
  const download = f.transport.download('a','file.txt',new AbortController().signal); const call = socket.sent.findLast(m => m.type === 'call'); const transferId = '66666666-6666-4666-8666-666666666666'
  socket.message({ v: 1, type: 'result', id: call.id, fence, result: { ok: true, value: { transferId, name: 'file.txt', mediaType: 'text/plain', offset: 0, bytes: 3, eof: true } } })
  let done = false; void download.then(() => { done = true }); socket.message(encodeChunk(transferId, fence.controlId, 0, new TextEncoder().encode('abc'))); await flush(); expect(done).toBe(false)
  socket.message({ v: 1, type: 'download.end', id: transferId, fence, chunks: 1 }); expect(await (await download).blob.text()).toBe('abc')
  const unavailable = f.transport.download('a','file.txt',new AbortController().signal); const next = socket.sent.findLast(m => m.type === 'call'); socket.message({ v: 1, type: 'result', id: next.id, fence, result: { ok: false, error: { code: 'PROTOCOL_UNSUPPORTED', message: 'PROTOCOL_UNSUPPORTED', retryable: false } } }); await expect(unavailable).rejects.toThrow('PROTOCOL_UNSUPPORTED'); f.transport.dispose()
})

test('negotiated heartbeat and call timeout preserve unrelated watch and never replay action', async () => {
  vi.useFakeTimers(); const f = fixture()
  try {
    const { socket, ready } = await f.connect(); socket.message({ v: 1, type: 'relay.config', limits: { ...DEFAULT_LIMITS, callTimeoutMs: 40 }, heartbeatMs: 10, leaseTtlMs: 80 }); socket.message({ v: 1, type: 'browser.lease', id: '44444444-4444-4444-8444-444444444444', resumeSecret: 'A'.repeat(43), fence, expiresAt: Date.now() + 80 }); socket.message({ v: 1, type: 'ready', fence }); f.context()!.barrier.ready(); await ready
    const pending = f.transport.call({ op: 'session.stop', sessionId: 'a', stopToken: 't' }); const check = expect(pending).rejects.toThrow('RESULT_UNCERTAIN')
    await vi.advanceTimersByTimeAsync(41); await check; expect(socket.sent.filter(m => m.type === 'heartbeat').length).toBeGreaterThan(0); expect(socket.sent.filter(m => m.type === 'call')).toHaveLength(1); expect(f.transport.getSnapshot().phase).toBe('ready')
    const call = socket.sent.find(m => m.type === 'call'); socket.message({ v: 1, type: 'result', id: call.id, fence, result: { ok: true, value: { accepted: true } } }); expect(f.transport.getSnapshot().phase).toBe('ready')
  } finally { f.transport.dispose(); vi.useRealTimers() }
})
test.each(['AUTH_REQUIRED','AUTH_EXPIRED','AUTH_REVOKED','REMOTE_BUSY','REMOTE_REPLACED','LIMIT_EXCEEDED'])('explicit %s fault cannot become ready through a late barrier', async code => {
  const f = fixture(); const { socket, ready } = await f.connect(); f.attach(socket); const old = f.context()!; socket.message({ v: 1, type: 'fault', error: { code, message: code, retryable: false } }); await expect(ready).rejects.toThrow(code); old.barrier.ready()
  expect(f.transport.getSnapshot()).toMatchObject({ code, fence: null, phase: code === 'AUTH_REVOKED' ? 'revoked' : code === 'REMOTE_REPLACED' ? 'replaced' : code === 'REMOTE_BUSY' ? 'busy' : 'error' }); f.transport.dispose()
})
test('upload waits for credit and durable receipt, sends exact chunk and end counts', async () => {
  const f = fixture(); const { socket, ready } = await f.connect(); f.attach(socket); f.context()!.barrier.ready(); await ready
  const uploaded = f.transport.upload('a', new File(['abc'], 'a.txt', { type: 'text/plain' }), new AbortController().signal); const opener = socket.sent.find(m => m.type === 'upload.open'); expect(socket.sent.filter(m => m instanceof Uint8Array)).toHaveLength(0)
  socket.message({ v: 1, type: 'upload.credit', id: opener.id, fence, chunks: 1 }); await vi.waitFor(() => expect(socket.sent.some(m => m.type === 'upload.end')).toBe(true))
  expect(socket.sent.find(m => m.type === 'upload.end').chunks).toBe(1); expect(socket.sent.filter(m => m instanceof Uint8Array)).toHaveLength(1)
  socket.message({ v: 1, type: 'result', id: opener.id, fence, result: { ok: true, value: { receiptId: 'receipt-a' } } }); expect(await uploaded).toEqual({ receiptId: 'receipt-a' }); f.transport.dispose()
})
test('partial download is discarded on disconnect; out-of-order bytes are never completed', async () => {
  for (const brokenOrder of [false,true]) {
    const f = fixture(); const { socket, ready } = await f.connect(); f.attach(socket); f.context()!.barrier.ready(); await ready
    const download = f.transport.download('a','a.txt',new AbortController().signal); const check = expect(download).rejects.toThrow(); const call = socket.sent.findLast(m => m.type === 'call'); const id = '66666666-6666-4666-8666-666666666666'
    socket.message({ v: 1, type: 'result', id: call.id, fence, result: { ok: true, value: { transferId: id, name: 'a.txt', mediaType: 'text/plain', offset: 0, bytes: 6, eof: true } } })
    socket.message(encodeChunk(id, fence.controlId, brokenOrder ? 1 : 0, new TextEncoder().encode('abc'))); if (!brokenOrder) socket.closed(); await check; f.transport.dispose()
  }
})
test('ready with wrong Fence and business before ACK are rejected', async () => {
  const f = fixture(); const { socket, ready } = await f.connect(); socket.message({ v: 1, type: 'ready', fence }); await expect(ready).rejects.toThrow('STALE_CONTROL'); f.transport.dispose()
})

import { controlStatus } from '../src/connect.ts'
test('cold cookie expiry is discovered over same-origin POST before native WebSocket hides the response', async () => {
  const socket = vi.fn(); const fetch = vi.fn(async () => new Response(JSON.stringify({ error: { code: 'AUTH_EXPIRED' } }), { status: 401 }))
  const transport = new BrowserTransport({ origin: 'https://relay.test', reconnect: false, socket, fetch })
  await expect(transport.connect(instanceId)).rejects.toThrow('AUTH_EXPIRED'); expect(socket).not.toHaveBeenCalled(); expect(transport.getSnapshot().code).toBe('AUTH_EXPIRED')
  expect(fetch.mock.calls[0]).toMatchObject([`/v1/instances/${instanceId}/control-status`, { method: 'POST', credentials: 'same-origin', redirect: 'error', body: '{}' }]); transport.dispose()
})
test('status success is advisory: busy race during native upgrade triggers bounded fresh status check', async () => {
  vi.useFakeTimers(); const sockets: Socket[] = []; let count = 0
  const fetch = vi.fn(async () => Response.json({ hostOnline: true, remoteConnected: count++ > 0 }))
  const transport = new BrowserTransport({ origin: 'https://relay.test', fetch, socket: () => { const socket = new Socket(); sockets.push(socket); return socket as unknown as WebSocket } })
  try { const connecting = transport.connect(instanceId); const result = expect(connecting).rejects.toThrow('HOST_OFFLINE'); await flush(); sockets[0].closed(); await result
    await vi.advanceTimersByTimeAsync(501); expect(fetch).toHaveBeenCalledTimes(2); expect(transport.getSnapshot().phase).toBe('busy'); expect(sockets).toHaveLength(1)
  } finally { transport.dispose(); vi.useRealTimers() }
})
test('status values cannot invent ready, release a lease, or classify unknown network failures as expiry', async () => {
  const fetch = vi.fn(async () => Response.json({ hostOnline: true, remoteConnected: false })); expect(await controlStatus(instanceId, fetch)).toEqual({ hostOnline: true, remoteConnected: false })
  const socket = vi.fn(); const transport = new BrowserTransport({ origin: 'https://relay.test', reconnect: false, socket, fetch: vi.fn().mockRejectedValue(Error('network')) })
  await expect(transport.connect(instanceId)).rejects.toThrow('network'); expect(transport.getSnapshot()).toMatchObject({ phase: 'offline', code: 'HOST_OFFLINE' }); expect(socket).not.toHaveBeenCalled(); transport.dispose()
})
test('multi-range download preserves offsets and checks final total before Blob creation', async () => {
  const f = fixture(); const { socket, ready } = await f.connect(); f.attach(socket); f.context()!.barrier.ready(); await ready
  const downloading = f.transport.download('a','a.txt',new AbortController().signal)
  for (let index = 0; index < 2; index++) {
    const call = socket.sent.findLast(m => m.type === 'call'); expect(call.command.offset).toBe(index * 3); const id = index ? '77777777-7777-4777-8777-777777777777' : '66666666-6666-4666-8666-666666666666'
    socket.message({ v: 1, type: 'result', id: call.id, fence, result: { ok: true, value: { transferId: id, name: 'a.txt', mediaType: 'text/plain', bytes: 3, offset: index * 3, eof: index === 1 } } })
    socket.message(encodeChunk(id,fence.controlId,0,new TextEncoder().encode(index ? 'def' : 'abc'))); socket.message({ v: 1, type: 'download.end', id, fence, chunks: 1 }); await flush()
  }
  expect(await (await downloading).blob.text()).toBe('abcdef'); f.transport.dispose()
})

test('WebSocket construction failure settles connect and cannot leave an eternal connecting phase', async () => {
  const transport = new BrowserTransport({ origin:'https://relay.test', reconnect:false, fetch: vi.fn(async () => Response.json({hostOnline:true,remoteConnected:false})), socket: () => { throw Error('socket unavailable') } })
  await expect(transport.connect(instanceId)).rejects.toThrow('HOST_OFFLINE'); expect(transport.getSnapshot().phase).toBe('offline'); transport.dispose()
})

test('download admission includes openers awaiting metadata, not only active byte receivers', async () => {
  const f = fixture(); const { socket, ready } = await f.connect(); f.attach(socket); f.context()!.barrier.ready(); await ready
  const signal = new AbortController(); const pending = Array.from({length:3},() => f.transport.download('a','a.txt',signal.signal).catch(error => error))
  try { await flush(); expect(socket.sent.filter(message => message.type === 'call')).toHaveLength(DEFAULT_LIMITS.uploads) }
  finally { signal.abort(); await Promise.all(pending); f.transport.dispose() }
})
test.each([{}, {error:{}}, {error:{code:123}}, {error:{code:'UNKNOWN_FAILURE'}}, {error:{code:'AUTH_UNKNOWN'}}])('untyped status 503 %j remains availability failure and not an auth claim', async body => {
  const socket = vi.fn(); const transport = new BrowserTransport({origin:'https://relay.test',reconnect:false,socket,fetch:vi.fn(async()=>Response.json(body,{status:503}))})
  await expect(transport.connect(instanceId)).rejects.toMatchObject({code:'HOST_OFFLINE'}); expect(transport.getSnapshot()).toMatchObject({phase:'offline',code:'HOST_OFFLINE'}); expect(socket).not.toHaveBeenCalled(); transport.dispose()
})
test('untyped HTTP failure uses bounded status recovery instead of requesting a new authorization link', async () => {
  vi.useFakeTimers(); const socket = new Socket(); const fetch = vi.fn().mockResolvedValueOnce(Response.json({},{status:503})).mockResolvedValue(Response.json({hostOnline:true,remoteConnected:false}))
  const transport = new BrowserTransport({origin:'https://relay.test',fetch,socket:()=>socket as unknown as WebSocket})
  try { await expect(transport.connect(instanceId)).rejects.toMatchObject({code:'HOST_OFFLINE'}); await vi.advanceTimersByTimeAsync(499); expect(fetch).toHaveBeenCalledTimes(1); await vi.advanceTimersByTimeAsync(1); expect(fetch).toHaveBeenCalledTimes(2); expect(transport.getSnapshot().phase).toBe('connecting') }
  finally { transport.dispose(); vi.useRealTimers() }
})
test('untyped failed login is availability failure; typed auth expiry retains its actual code', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(Response.json({},{status:503})).mockResolvedValueOnce(Response.json({error:{code:'AUTH_EXPIRED'}},{status:401}))
  const authorization = new BrowserAuthorization({href:'https://relay.test/#key=page-local',history:{state:null,replaceState(){}},fetch})
  await expect(authorization.authorize(instanceId)).rejects.toMatchObject({code:'HOST_OFFLINE'}); await expect(authorization.authorize(instanceId)).rejects.toMatchObject({code:'AUTH_EXPIRED'})
})

test('non-JSON failed HTTP response never invents an authentication cause', async () => {
  await expect(controlStatus(instanceId, vi.fn(async () => new Response('<html>proxy error</html>', {status:503})))).rejects.toMatchObject({code:'HOST_OFFLINE',retryable:true})
})

test('login fetch failure cannot be relabeled as missing authorization by transport', async () => {
  const authorization = new BrowserAuthorization({href:'https://relay.test/#key=page-local',history:{state:null,replaceState(){}},fetch:vi.fn().mockRejectedValue(Error('login network failure'))})
  const transport = new BrowserTransport({origin:'https://relay.test',reconnect:false,authorization,socket:vi.fn()})
  await expect(transport.connect(instanceId)).rejects.toThrow('login network failure'); expect(transport.getSnapshot()).toMatchObject({phase:'offline',code:'HOST_OFFLINE'}); transport.dispose()
})

test('own lease recovery probes multiple busy snapshots and stops after bounded retries; other page retries explicitly', async () => {
  vi.useFakeTimers()
  const fetch = vi.fn(async () => Response.json({ hostOnline: true, remoteConnected: true })); const socket = new Socket()
  const transport = new BrowserTransport({ origin: 'https://relay.test', fetch, storage: { getItem: () => JSON.stringify({ id: '44444444-4444-4444-8444-444444444444', secret: 'A'.repeat(43) }) } as unknown as Storage, socket: () => socket as unknown as WebSocket })
  try {
    const connecting = transport.connect(instanceId); const failure = expect(connecting).rejects.toThrow('HOST_OFFLINE'); await flush(); socket.open()
    expect(socket.sent[0]).toMatchObject({ takeover: true }); socket.closed(); await failure
    await vi.advanceTimersByTimeAsync(500); await vi.advanceTimersByTimeAsync(1000)
    expect(fetch).toHaveBeenCalledTimes(3); expect(transport.getSnapshot().phase).toBe('busy')
    await vi.advanceTimersByTimeAsync(1000000); expect(fetch).toHaveBeenCalledTimes(8)
    await vi.advanceTimersByTimeAsync(1000000); expect(fetch).toHaveBeenCalledTimes(8)
    fetch.mockImplementation(async () => Response.json({ hostOnline: true, remoteConnected: false }))
    const retry = transport.retry(); void retry.catch(() => {}); await flush()
    expect(transport.getSnapshot().phase).toBe('connecting'); expect(fetch).toHaveBeenCalledTimes(9)
    socket.open(); expect(socket.sent.at(-1)).toMatchObject({ takeover: true }); transport.dispose(); await expect(retry).rejects.toThrow()
  } finally { transport.dispose(); vi.useRealTimers() }
})

for (const retirement of ['fault', 'close']) test(`replacement by ${retirement} is terminal, mutations uncertain, explicit retake retains synchronization gate`, async () => {
  vi.useFakeTimers(); const sockets: Socket[] = []; const fetch = vi.fn(async () => Response.json({ hostOnline: true, remoteConnected: true }))
  const transport = new BrowserTransport({ origin: 'https://relay.test', fetch, socket: () => { const socket = new Socket(); sockets.push(socket); return socket as unknown as WebSocket } })
  let sync!: SyncGeneration; transport.registerSynchronizer(value => { sync = value })
  const attach = (socket: Socket, incoming = fence) => {
    socket.message({ v: 1, type: 'relay.config', limits: DEFAULT_LIMITS, heartbeatMs: 10_000, leaseTtlMs: 30_000 })
    socket.message({ v: 1, type: 'browser.lease', id: '44444444-4444-4444-8444-444444444444', resumeSecret: 'A'.repeat(43), fence: incoming, expiresAt: Date.now() + 30000 })
    socket.message({ v: 1, type: 'ready', fence: incoming })
  }
  try {
    const opening = transport.connect(instanceId); await flush(); const socket = sockets[0]; socket.open()
    expect(socket.sent[0]).toMatchObject({ takeover: true }); attach(socket); sync.barrier.ready(); await opening; const old = sync
    const sent = transport.call({ op: 'session.stop', sessionId: 'a', stopToken: 'stop' }); const uncertain = expect(sent).rejects.toThrow('RESULT_UNCERTAIN')
    if (retirement === 'fault') socket.message({ v: 1, type: 'fault', error: { code: 'REMOTE_REPLACED', message: 'REMOTE_REPLACED', retryable: false } })
    else socket.closed('REMOTE_REPLACED')
    await uncertain; expect(transport.getSnapshot()).toMatchObject({ phase: 'replaced', fence: null }); old.barrier.ready()
    for (const command of [{ op: 'session.stop', sessionId: 'a', stopToken: 't' }, { op: 'interaction.answer', deliveryId: 'd', answer: true }, { op: 'session.prompt', sessionId: 'a', requestId: fence.controlId, mode: 'queue', content: [{ kind: 'text', text: 'hello' }] }] as const) await expect(transport.call(command as any)).rejects.toThrow('HOST_OFFLINE')
    await expect(transport.upload('a', new File(['a'], 'a.txt'), new AbortController().signal)).rejects.toThrow('HOST_OFFLINE')
    await vi.advanceTimersByTimeAsync(1000000); expect(fetch).toHaveBeenCalledTimes(1); expect(sockets).toHaveLength(1)
    const retry = transport.retry(); await flush(); const next = sockets[1]; next.open(); expect(next.sent[0]).toMatchObject({ takeover: true })
    attach(next, { ...fence, controlId: '55555555-5555-4555-8555-555555555555' }); old.barrier.ready(); expect(transport.getSnapshot().phase).toBe('syncing')
    await expect(transport.call({ op: 'session.stop', sessionId: 'a', stopToken: 't' })).rejects.toThrow('SYNC_REQUIRED'); sync.barrier.ready(); await retry
    expect(next.sent.some(m => m.type === 'call')).toBe(false)
  } finally { transport.dispose(); vi.useRealTimers() }
})

test('generic close without replacement fault recovers by resume only; copied storage never promotes automatic takeover', async () => {
  vi.useFakeTimers(); const sockets: Socket[] = []; let remoteConnected = false
  const transport = new BrowserTransport({ origin: 'https://relay.test', fetch: vi.fn(async () => Response.json({ hostOnline: true, remoteConnected })), socket: () => { const socket = new Socket(); sockets.push(socket); return socket as unknown as WebSocket } })
  let sync!: SyncGeneration; transport.registerSynchronizer(value => { sync = value })
  try {
    const ready = transport.connect(instanceId); await flush(); const first = sockets[0]; first.open()
    first.message({ v: 1, type: 'relay.config', limits: DEFAULT_LIMITS, heartbeatMs: 10000, leaseTtlMs: 30000 })
    first.message({ v: 1, type: 'browser.lease', id: '44444444-4444-4444-8444-444444444444', resumeSecret: 'A'.repeat(43), fence, expiresAt: 30000 })
    first.message({ v: 1, type: 'ready', fence }); sync.barrier.ready(); await ready; first.closed()
    await vi.advanceTimersByTimeAsync(501); const recovery = sockets[1]; recovery.open()
    expect(recovery.sent[0]).toMatchObject({ resume: { secret: 'A'.repeat(43) } }); expect(recovery.sent[0]).not.toHaveProperty('takeover')
    recovery.message({ v: 1, type: 'fault', error: { code: 'REMOTE_BUSY', message: 'REMOTE_BUSY', retryable: false } }); remoteConnected = true
    await vi.advanceTimersByTimeAsync(1000000); expect(sockets).toHaveLength(2); expect(transport.getSnapshot().phase).toBe('busy')
  } finally { transport.dispose(); vi.useRealTimers() }
})

test('management shares the write barrier and uncertain-after-send semantics', async () => {
  const f=fixture(),{socket,ready}=await f.connect();f.attach(socket)
  const command={op:'ui.manage',action:{kind:'workspace.delete',workspaceId:'w'}} as const
  try {
    await expect(f.transport.call(command)).rejects.toThrow('SYNC_REQUIRED')
    expect(socket.sent.filter(row=>row.type==='call')).toHaveLength(0)
    f.context()!.barrier.ready();await ready
    const controller=new AbortController(),pending=f.transport.call(command,controller.signal)
    const rejected=expect(pending).rejects.toThrow('RESULT_UNCERTAIN')
    await flush();controller.abort();await rejected
    expect(socket.sent.filter(row=>row.type==='call')).toHaveLength(1)
  } finally { f.transport.dispose() }
})

const largeProfile: SelectedUiProfile = { host: { ...RC2_UI_PROFILE, capabilities: [...RC2_UI_PROFILE.capabilities, LARGE_JSON_CAPABILITY] }, runtimeId: fence.runtimeId, uiRevision: 'a'.repeat(64) }
test('opted native catalog is delivered only after all fragments and preserves every field', async () => {
  const f = fixture(largeProfile); const { socket, ready } = await f.connect(); f.attach(socket); f.context()!.barrier.ready(); await ready
  try {
    const pending = f.transport.call({ op: 'ui.catalog' }); const call = socket.sent.at(-1); expect(call.fragments).toBe(true)
    const value = { items: [{ sessionId: 'a', projections: { progress: '完整🚀'.repeat(50000) } }] }
    const message = { v: 1, type: 'result', id: call.id, fence, result: { ok: true, value } } as const
    const parts = [...fragmentJson(message, JSON.stringify(message), DEFAULT_LIMITS)]; let delivered = false; void pending.then(() => { delivered = true })
    for (const part of parts.slice(0, -1)) socket.message(part)
    await flush(); expect(delivered).toBe(false)
    socket.message(parts.at(-1)); expect(await pending).toEqual(value); expect((f.transport as any).queuedBytes).toBe(0)
  } finally { f.transport.dispose() }
})
test.each(['call', 'watch'] as const)('cancelling a partial %s drops its body and drains late fragments', async kind => {
  const f = fixture(largeProfile); const { socket, ready } = await f.connect(); f.attach(socket); f.context()!.barrier.ready(); await ready
  const control = new AbortController()
  try {
    const iterator = kind === 'watch' ? f.transport.watch({ topic: 'sessions' }, control.signal)[Symbol.asyncIterator]() : undefined
    const pending = iterator ? iterator.next() : f.transport.call({ op: 'ui.catalog' }, control.signal)
    const check = expect(pending).rejects.toThrow('TRANSFER_CLOSED'); const opener = socket.sent.at(-1)
    const value = { data: '中'.repeat(120000) }
    const message = kind === 'call' ? { v: 1 as const, type: 'result' as const, id: opener.id, fence, result: { ok: true as const, value } } : { v: 1 as const, type: 'event' as const, id: opener.id, fence, value }
    const parts = [...fragmentJson(message, JSON.stringify(message), DEFAULT_LIMITS)]
    socket.message(parts[0]); expect((f.transport as any).queuedBytes).toBeGreaterThan(0)
    control.abort(); await check; expect((f.transport as any).queuedBytes).toBe(0)
    for (const part of parts.slice(1)) socket.message(part)
    if (kind === 'watch') socket.message({ v: 1, type: 'end', id: opener.id, fence })
    expect(f.transport.getSnapshot().phase).toBe('ready'); expect((f.transport as any).recent.get(opener.id).drained).toBe(true)
  } finally { f.transport.dispose() }
})
test('large watch events preserve original boundaries and release assembly ownership', async () => {
  const f = fixture(largeProfile); const { socket, ready } = await f.connect(); f.attach(socket); f.context()!.barrier.ready(); await ready
  const control = new AbortController(); const iterator = f.transport.watch({ topic: 'sessions' }, control.signal)[Symbol.asyncIterator]()
  try {
    const pending = iterator.next(); const opener = socket.sent.at(-1)
    const value = { kind: 'dsh', value: { type: 'baseline', value: { projections: { a: { asOfSeq: 12, values: { progress: '进度'.repeat(70000) } } } } } }
    const message = { v: 1, type: 'event', id: opener.id, fence, value } as const
    for (const part of fragmentJson(message, JSON.stringify(message), DEFAULT_LIMITS)) socket.message(part)
    expect((await pending).value).toEqual(value); expect((f.transport as any).queuedBytes).toBe(0)
  } finally { control.abort(); await iterator.return?.(); f.transport.dispose() }
})
test('unopted or internally mismatched fragments close without applying a result', async () => {
  for (const profile of [undefined, largeProfile]) {
    const f = fixture(profile); const { socket, ready } = await f.connect(); f.attach(socket); f.context()!.barrier.ready(); await ready
    try {
      const pending = f.transport.call({ op: 'ui.catalog' }); const check = expect(pending).rejects.toThrow('RESULT_UNCERTAIN'); const call = socket.sent.at(-1)
      const message = { v: 1, type: 'result', id: call.id, fence: { ...fence, authEpoch: 2 }, result: { ok: true, value: 'a'.repeat(300000) } } as const
      for (const part of fragmentJson(message, JSON.stringify(message), DEFAULT_LIMITS)) socket.message({ ...part, fence })
      await check; expect(f.transport.getSnapshot().code).toBe('INVALID_MESSAGE'); expect((f.transport as any).queuedBytes).toBe(0)
    } finally { f.transport.dispose() }
  }
})
test('partial event has an absolute deadline after a prior baseline and releases on timeout', async () => {
  vi.useFakeTimers(); const f = fixture(largeProfile); const control = new AbortController()
  try {
    const { socket, ready } = await f.connect(); f.attach(socket); f.context()!.barrier.ready(); await ready
    const iterator = f.transport.watch({ topic: 'sessions' }, control.signal)[Symbol.asyncIterator](); const first = iterator.next(); const opener = socket.sent.at(-1)
    socket.message({ v: 1, type: 'event', id: opener.id, fence, value: 'baseline' }); await first
    const pending = iterator.next(); const check = expect(pending).rejects.toThrow('TRANSFER_TIMEOUT')
    const message = { v: 1, type: 'event', id: opener.id, fence, value: 'a'.repeat(300000) } as const
    const parts = [...fragmentJson(message, JSON.stringify(message), DEFAULT_LIMITS)]
    socket.message(parts[0]); await vi.advanceTimersByTimeAsync(29000); socket.message(parts[1]); await vi.advanceTimersByTimeAsync(1001)
    await check; expect((f.transport as any).queuedBytes).toBe(0); expect(socket.sent.some(m => m.type === 'cancel' && m.id === opener.id)).toBe(true)
  } finally { control.abort(); f.transport.dispose(); vi.useRealTimers() }
})
