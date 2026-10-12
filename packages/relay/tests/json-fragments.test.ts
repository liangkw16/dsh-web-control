import { expect, test } from 'vitest'
import { DEFAULT_LIMITS, RC2_UI_PROFILE, NATIVE_UI_MARKER, LARGE_JSON_CAPABILITY, fragmentJson } from '@dsh-web-control/protocol'
import { fixture, hello, delay } from './socket-fixture.ts'
const id = '30000000-0000-4000-8000-000000000021'
const keep = '30000000-0000-4000-8000-000000000022'
const capabilities = [...RC2_UI_PROFILE.capabilities, NATIVE_UI_MARKER, LARGE_JSON_CAPABILITY]
test.each(['call', 'watch'] as const)('Relay forwards an opted large %s without assembling or completing early', async kind => {
  const f = await fixture()
  try {
    await f.register(); const h = await f.host({ ...hello, capabilities }); await h.next('relay.ack'); const { b, fence } = await f.attach(h, await f.login())
    b.send(kind === 'call' ? { v: 1, type: kind, id, fence, fragments: true, command: { op: 'ui.catalog' } } : { v: 1, type: kind, id, fence, fragments: true, watch: { topic: 'sessions' } })
    expect((await h.next(kind)).fragments).toBe(true)
    const value = { original: '大目录🚀'.repeat(30000) }
    const message = kind === 'call' ? { v: 1 as const, type: 'result' as const, id, fence, result: { ok: true as const, value } } : { v: 1 as const, type: 'event' as const, id, fence, value }
    const parts = [...fragmentJson(message, JSON.stringify(message), DEFAULT_LIMITS)]
    for (const part of parts) { h.send(part); expect(await b.next('json.fragment')).toEqual(part) }
    if (kind === 'watch') { h.send({ v: 1, type: 'event', id, fence, value: 'next' }); expect((await b.next('event')).value).toBe('next'); h.send({ v: 1, type: 'end', id, fence }); await b.next('end') }
    b.send({ v: 1, type: 'call', id: keep, fence, command: { op: 'session.list', workspaceId: 'w' } }); await h.next('call')
    h.send({ v: 1, type: 'result', id: keep, fence, result: { ok: true, value: [] } }); expect((await b.next('result')).result.ok).toBe(true)
  } finally { await f.close() }
})
test.each(['call', 'watch'] as const)('Relay cancellation during %s fragments drains metadata and preserves other operations', async kind => {
  const f = await fixture()
  try {
    await f.register(); const h = await f.host({ ...hello, capabilities }); await h.next('relay.ack'); const { b, fence } = await f.attach(h, await f.login())
    b.send(kind === 'call' ? { v: 1, type: kind, id, fence, fragments: true, command: { op: 'ui.catalog' } } : { v: 1, type: kind, id, fence, fragments: true, watch: { topic: 'sessions' } }); await h.next(kind)
    const message = kind === 'call' ? { v: 1 as const, type: 'result' as const, id, fence, result: { ok: true as const, value: 'x'.repeat(300000) } } : { v: 1 as const, type: 'event' as const, id, fence, value: 'x'.repeat(300000) }
    const parts = [...fragmentJson(message, JSON.stringify(message), DEFAULT_LIMITS)]; h.send(parts[0]); await b.next('json.fragment')
    b.send({ v: 1, type: 'cancel', id, fence }); await h.next('cancel')
    for (const part of parts.slice(1)) h.send(part)
    if (kind === 'watch') h.send({ v: 1, type: 'end', id, fence })
    b.send({ v: 1, type: 'watch', id: keep, fence, watch: { topic: 'workspaces' } }); await h.next('watch')
    h.send({ v: 1, type: 'event', id: keep, fence, value: 'alive' }); expect((await b.next('event')).value).toBe('alive')
    expect(b.messages.some(m => m.type === 'json.fragment' || m.type === 'fault')).toBe(false)
  } finally { await f.close() }
})
test.each(['missing-opt-in', 'wrong-kind', 'order', 'early-end'] as const)('Relay rejects %s fragment sequence', async variant => {
  const f = await fixture()
  try {
    await f.register(); const h = await f.host({ ...hello, capabilities }); await h.next('relay.ack'); const { b, fence } = await f.attach(h, await f.login())
    b.send({ v: 1, type: 'watch', id, fence, ...(variant === 'missing-opt-in' ? {} : { fragments: true }), watch: { topic: 'sessions' } }); await h.next('watch')
    const message = { v: 1, type: 'event', id, fence, value: 'x'.repeat(300000) } as const
    const parts = [...fragmentJson(message, JSON.stringify(message), DEFAULT_LIMITS)]
    if (variant === 'early-end') { h.send(parts[0]); await b.next('json.fragment'); h.send({ v: 1, type: 'end', id, fence }) }
    else h.send(variant === 'wrong-kind' ? { ...parts[0], logicalType: 'result' } : variant === 'order' ? parts[1] : parts[0])
    expect((await b.next('fault')).error.code).toBe('INVALID_MESSAGE')
  } finally { await f.close() }
})
test('old Host cannot be opted in and original small frames remain supported', async () => {
  const f = await fixture()
  try {
    await f.register(); const h = await f.host(); await h.next('relay.ack'); const { b, fence } = await f.attach(h, await f.login())
    b.send({ v: 1, type: 'call', id, fence, fragments: true, command: { op: 'ui.catalog' } })
    expect((await b.next('fault')).error.code).toBe('PROTOCOL_UNSUPPORTED'); expect(h.messages.some(m => m.type === 'call')).toBe(false)
  } finally { await f.close() }
})

import WebSocket from 'ws'
import { BrowserTransport } from '../../web/src/transport.ts'
import { runtimeId, instanceId } from './socket-fixture.ts'
test.each(['call', 'watch'] as const)('real Browser and Relay retain no cancelled %s body past the drain deadline', async kind => {
  const f = await fixture({ nativeUiReleases: [{ dshVersion: '0.2.0-rc.2', adapter: 'rc2-native-1', revision: 'a'.repeat(64) }], limits: { ...DEFAULT_LIMITS, callTimeoutMs: 300, transferIdleMs: 300 } })
  let transport: BrowserTransport | undefined
  try {
    await f.register(); const cookie = await f.login(); const h = await f.host({ ...hello, capabilities }); await h.next('relay.ack')
    transport = new BrowserTransport({ origin: f.config.publicOrigin, reconnect: false, uiProfile: { host: { ...RC2_UI_PROFILE, capabilities: [...RC2_UI_PROFILE.capabilities, LARGE_JSON_CAPABILITY] }, runtimeId, uiRevision: 'a'.repeat(64) }, fetch: async () => Response.json({ hostOnline: true, remoteConnected: false }), socket: url => new WebSocket(f.http().replace(/^http:/, 'ws:') + new URL(url).pathname, { headers: { Cookie: cookie, Origin: f.config.publicOrigin } }) as unknown as globalThis.WebSocket })
    transport.registerSynchronizer(({ barrier }) => barrier.ready())
    const ready = transport.connect(instanceId); const attach = await h.next('attach'); h.send({ v: 1, type: 'host.attached', id: attach.id, fence: attach.fence }); await ready
    const abort = new AbortController(); const iterator = kind === 'watch' ? transport.watch({ topic: 'sessions' }, abort.signal)[Symbol.asyncIterator]() : undefined
    const pending = iterator ? iterator.next() : transport.call({ op: 'ui.catalog' }, abort.signal); const rejected = expect(pending).rejects.toThrow('TRANSFER_CLOSED')
    const opener = await h.next(kind), fence = opener.fence
    const message = kind === 'call' ? { v: 1 as const, type: 'result' as const, id: opener.id, fence, result: { ok: true as const, value: 'x'.repeat(300000) } } : { v: 1 as const, type: 'event' as const, id: opener.id, fence, value: 'x'.repeat(300000) }
    const parts = [...fragmentJson(message, JSON.stringify(message), DEFAULT_LIMITS)]
    h.send(parts[0]); await delay(15); abort.abort(); await rejected; await h.next('cancel')
    for (const part of parts.slice(1)) h.send(part)
    if (kind === 'watch') h.send({ v: 1, type: 'end', id: opener.id, fence })
    await delay(1100)
    expect(transport.getSnapshot().phase).toBe('ready'); expect((transport as any).queuedBytes).toBe(0); expect((transport as any).recent.size).toBe(0)
  } finally { transport?.dispose(); await f.close() }
})

import { vi } from 'vitest'
import { BrowserSocket } from '../src/browser-socket.ts'
test.each(['before-dispatch', 'after-host-terminal'] as const)('opted cancellation %s acknowledges drain even without another Host reply', async timing => {
  vi.useFakeTimers()
  const controlId = '30000000-0000-4000-8000-000000000023', leaseId = '30000000-0000-4000-8000-000000000024'
  const fence = { instanceId, runtimeId, controlId, authEpoch: 1 }, limits = { ...DEFAULT_LIMITS, callTimeoutMs: 300, transferIdleMs: 300 }
  const profile = { host: { ...RC2_UI_PROFILE, capabilities: [...RC2_UI_PROFILE.capabilities, LARGE_JSON_CAPABILITY] }, runtimeId, uiRevision: 'a'.repeat(64) }
  type Queued = { message: any; guard?: () => void; settled?: () => void }
  const toHost: Queued[] = [], toBrowser: Queued[] = [], dispatched: any[] = []
  const queued = (queue: Queued[]) => ({ send: (message: any, guard?: () => void, settled?: () => void) => queue.push({ message, guard, settled }), close() {} })
  let backend!: BrowserSocket
  class Socket extends EventTarget {
    readyState = 1; bufferedAmount = 0; binaryType = ''
    send(text: string) { backend.receive(Buffer.from(text), false) }
    close() { this.readyState = 3 }
    emit(message: unknown) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) })) }
  }
  const socket = new Socket()
  const lease = { id: leaseId, controlId, resumeSecret: 'A'.repeat(43), expiresAt: Date.now() + 30000 }
  backend = new BrowserSocket(instanceId, 'fixture', { limits, runtimeId, authEpoch: 1, uiProfile: profile.host, current() {}, attach: async () => {}, detach() {}, transport: queued(toHost) } as any, queued(toBrowser) as any, { authorize: () => ({ authEpoch: 1 }) } as any, { acquire: () => lease, get: () => lease, heartbeat() {}, release() {}, disconnected() {} } as any, { heartbeatMs: 10000, leaseTtlMs: 30000 }, () => {}, undefined, undefined, [{ dshVersion: '0.2.0-rc.2', adapter: 'rc2-native-1', revision: profile.uiRevision }])
  const frontend = new BrowserTransport({ origin: 'https://relay.test', reconnect: false, uiProfile: profile, fetch: async () => Response.json({ hostOnline: true, remoteConnected: false }), socket: () => socket as unknown as globalThis.WebSocket })
  const flush = (queue: Queued[], deliver: (message: any) => void, once = false) => { do { const item = queue.shift(); if (!item) break; try { item.guard?.(); deliver(item.message) } catch (error) { expect(error).toMatchObject({ code: 'TRANSFER_CLOSED' }) } finally { item.settled?.() } } while (!once) }
  frontend.registerSynchronizer(({ barrier }) => barrier.ready())
  try {
    const ready = frontend.connect(instanceId); for (let i = 0; i < 8; i++) await Promise.resolve(); socket.dispatchEvent(new Event('open'))
    flush(toBrowser, message => socket.emit(message)); for (let i = 0; i < 8; i++) await Promise.resolve(); flush(toBrowser, message => socket.emit(message)); await ready
    const abort = new AbortController(), pending = frontend.call({ op: 'ui.catalog' }, abort.signal), rejected = expect(pending).rejects.toThrow('TRANSFER_CLOSED')
    if (timing === 'after-host-terminal') {
      flush(toHost, message => dispatched.push(message)); const opener = dispatched[0]
      const message = { v: 1, type: 'result', id: opener.id, fence, result: { ok: true, value: 'x'.repeat(300000) } } as const
      for (const part of fragmentJson(message, JSON.stringify(message), DEFAULT_LIMITS)) backend.fromHost(Buffer.from(JSON.stringify(part)), false)
      flush(toBrowser, message => socket.emit(message), true)
    }
    abort.abort(); await rejected; flush(toHost, message => dispatched.push(message)); flush(toBrowser, message => socket.emit(message))
    await vi.advanceTimersByTimeAsync(1100)
    expect(frontend.getSnapshot().phase).toBe('ready'); expect((frontend as any).queuedBytes).toBe(0); expect((frontend as any).recent.size).toBe(0)
    if (timing === 'before-dispatch') expect(dispatched).toHaveLength(0)
  } finally { frontend.dispose(); backend.disconnected(); vi.useRealTimers() }
})
