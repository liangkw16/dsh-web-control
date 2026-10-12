import { expect, test, vi } from 'vitest'
import { fixture, instanceId } from './socket-fixture.ts'

test('deliberate valid browser claim replaces the current controller only after hello and awaits Host ACK', async () => {
  const f = await fixture()
  try {
    await f.register(); const h = await f.host(); await h.next('relay.ack')
    const cookie = await f.login(); const first = await f.attach(h, cookie)
    const next = f.socket(`/v1/instances/${instanceId}/control`, { Cookie: cookie, Origin: f.config.publicOrigin })
    await next.open()
    // An upgraded socket alone has no ownership.
    first.b.send({ v: 1, type: 'heartbeat', fence: first.fence })
    next.send({ v: 1, type: 'browser.hello', versions: [1], takeover: true })
    const lease = await next.next('browser.lease')
    expect((await first.b.next('fault')).error.code).toBe('REMOTE_REPLACED')
    expect(lease.fence.controlId).not.toBe(first.fence.controlId)
    expect((await h.next('detach')).fence).toEqual(first.fence)
    next.send({ v: 1, type: 'browser.lease-ack', id: lease.id })
    const attach = await h.next('attach')
    expect(next.messages.some(m => m.type === 'ready')).toBe(false)
    h.send({ v: 1, type: 'host.attached', id: attach.id, fence: attach.fence })
    expect((await next.next('ready')).fence).toEqual(attach.fence)
  } finally { await f.close() }
})

import { delay } from './socket-fixture.ts'
import { encodeChunk } from '../../protocol/src/index.ts'
const commandId = '30000000-0000-0000-0000-000000000001'

test('unauthorized upgrade, malformed and unsupported hello and legacy/copy resume never evict owner', async () => {
  const f = await fixture()
  try {
    await f.register(); const h = await f.host(); await h.next('relay.ack')
    const cookie = await f.login(); const first = await f.attach(h, cookie)
    for (const headers of [{ Origin: f.config.publicOrigin }, { Cookie: cookie, Origin: 'https://evil.example' }] as Record<string, string>[]) {
      const p = f.socket(`/v1/instances/${instanceId}/control`, headers)
      await expect(p.open()).rejects.toThrow('Unexpected server response')
    }
    for (const [hello, code] of [
      [{ v: 1, type: 'browser.hello', versions: [1], takeover: false }, 'INVALID_MESSAGE'],
      [{ v: 1, type: 'browser.hello', versions: [2], takeover: true }, 'PROTOCOL_UNSUPPORTED'],
      [{ v: 1, type: 'browser.hello', versions: [1], takeover: true, extra: 'bad' }, 'INVALID_MESSAGE'],
      [{ v: 1, type: 'browser.hello', versions: [1] }, 'REMOTE_BUSY'],
      [{ v: 1, type: 'browser.hello', versions: [1], resume: { id: first.lease.id, secret: first.lease.resumeSecret } }, 'REMOTE_BUSY'],
    ] as const) {
      const p = f.socket(`/v1/instances/${instanceId}/control`, { Cookie: cookie, Origin: f.config.publicOrigin })
      await p.open(); p.send(hello); expect((await p.next('fault')).error.code).toBe(code)
      first.b.send({ v: 1, type: 'heartbeat', fence: first.fence })
    }
    first.b.send({ v: 1, type: 'call', id: commandId, fence: first.fence, command: { op: 'session.list', workspaceId: 'w' } })
    expect((await h.next('call')).fence).toEqual(first.fence)
    expect(h.messages.some(m => m.type === 'detach')).toBe(false)
    expect(first.b.messages.some(m => m.type === 'fault')).toBe(false)
  } finally { await f.close() }
})

test('concurrent deliberate claims replace pending attach; stale ACK/close/business/binary/result cannot disturb last owner', async () => {
  const f = await fixture()
  try {
    await f.register(); const h = await f.host(); await h.next('relay.ack')
    const cookie = await f.login(); const first = await f.attach(h, cookie)
    const openClaim = async () => {
      const p = f.socket(`/v1/instances/${instanceId}/control`, { Cookie: cookie, Origin: f.config.publicOrigin }); await p.open()
      p.send({ v: 1, type: 'browser.hello', versions: [1], takeover: true, resume: { id: first.lease.id, secret: first.lease.resumeSecret } })
      const lease = await p.next('browser.lease'); p.send({ v: 1, type: 'browser.lease-ack', id: lease.id }); return { p, lease }
    }
    const second = await openClaim(); const pending = await h.next('attach')
    const third = await openClaim(); const attach = await h.next('attach')
    expect((await second.p.next('fault')).error.code).toBe('REMOTE_REPLACED')
    h.send({ v: 1, type: 'host.attached', id: pending.id, fence: pending.fence })
    await delay(10); expect(third.p.messages.some(m => m.type === 'ready')).toBe(false)
    h.send({ v: 1, type: 'host.attached', id: attach.id, fence: attach.fence }); await third.p.next('ready')
    await first.b.close(); await second.p.close()
    h.send({ v: 1, type: 'result', id: commandId, fence: pending.fence, result: { ok: true, value: {} } })
    h.ws.send(encodeChunk(commandId, pending.fence.controlId, 0, new Uint8Array([1])))
    third.p.send({ v: 1, type: 'heartbeat', fence: attach.fence })
    third.p.send({ v: 1, type: 'call', id: commandId, fence: attach.fence, command: { op: 'session.list', workspaceId: 'w' } })
    expect((await h.next('call')).fence).toEqual(attach.fence)
    await delay(15); expect(third.p.messages.some(m => ['fault', 'result', 'binary'].includes(m.type))).toBe(false)
    // A generic-close old page that lost the fault still has only stale resume credentials.
    const stale = await f.browser(cookie, { id: first.lease.id, secret: first.lease.resumeSecret })
    expect((await stale.next('fault')).error.code).toBe('REMOTE_BUSY')
    expect(h.messages.filter(m => m.type === 'detach').every(m => m.fence.controlId !== attach.fence.controlId)).toBe(true)
  } finally { await f.close() }
})

test('near-simultaneous claims leave exactly the last lease current', async () => {
  const f = await fixture()
  try {
    await f.register(); const h = await f.host(); await h.next('relay.ack'); const cookie = await f.login()
    const peers = await Promise.all(Array.from({ length: 3 }, async () => {
      const p = f.socket(`/v1/instances/${instanceId}/control`, { Cookie: cookie, Origin: f.config.publicOrigin }); await p.open(); return p
    }))
    const closed: string[] = []; peers.forEach(p => p.ws.on('close', (_code, reason) => closed.push(reason.toString())))
    peers.forEach(p => p.send({ v: 1, type: 'browser.hello', versions: [1], takeover: true }))
    await vi.waitFor(() => expect(peers.filter(p => p.ws.readyState === 1)).toHaveLength(1))
    expect(closed).toEqual(['REMOTE_REPLACED', 'REMOTE_REPLACED'])
    const winners = peers.filter(p => p.ws.readyState === 1)
    expect(winners).toHaveLength(1); const winner = winners[0]; const lease = await winner.next('browser.lease')
    winner.send({ v: 1, type: 'browser.lease-ack', id: lease.id }); const attach = await h.next('attach')
    h.send({ v: 1, type: 'host.attached', id: attach.id, fence: attach.fence }); await winner.next('ready')
    expect(attach.fence).toEqual(lease.fence)
  } finally { await f.close() }
})

import { BrowserSocket } from '../src/browser-socket.ts'
import { HostSocket } from '../src/host-socket.ts'
import { LeaseTable } from '../src/leases.ts'
import type { AuthStore } from '../src/auth.ts'
import type { Transport, TransportGroup } from '../src/transport.ts'
import { DEFAULT_LIMITS } from '../../protocol/src/index.ts'
import { runtimeId } from './socket-fixture.ts'

test('takeover fences already queued old mutation/chunk/result and stale direct socket frames', async () => {
  const queued: { value: any; guard?: () => void }[] = []
  const hostTransport = { send: (value: any, guard?: () => void) => queued.push({ value, guard }), sendChunk: (value: any, guard?: () => void) => queued.push({ value, guard }) } as unknown as Transport
  const host = new HostSocket(instanceId, runtimeId, commandId, 1, DEFAULT_LIMITS, hostTransport, {} as TransportGroup, () => {})
  const leases = new LeaseTable({ now: Date.now }, 30000)
  const auth = { authorize: () => ({ authEpoch: 1 }) } as unknown as AuthStore
  const browserFrames: { value: any; guard?: () => void }[] = []
  const transport = { send: (value: any, guard?: () => void) => browserFrames.push({ value, guard }), close: () => {} } as unknown as Transport
  const old = new BrowserSocket(instanceId, 'owned-cookie', host, transport, auth, leases, { heartbeatMs: 10000, leaseTtlMs: 30000 }, () => {})
  const incoming = (browser: BrowserSocket, value: any) => browser.receive(Buffer.from(JSON.stringify(value)), false)
  let next: BrowserSocket | undefined
  try {
    incoming(old, { v: 1, type: 'browser.hello', versions: [1] }); const lease = browserFrames.find(f => f.value.type === 'browser.lease')!.value
    incoming(old, { v: 1, type: 'browser.lease-ack', id: lease.id }); const attach = queued.find(f => f.value.type === 'attach')!.value
    host.attached({ v: 1, type: 'host.attached', id: attach.id, fence: attach.fence }); await Promise.resolve()
    incoming(old, { v: 1, type: 'call', id: commandId, fence: old.fence, command: { op: 'session.stop', sessionId: 's', stopToken: 't' } })
    const mutation = queued.at(-1)!
    const uploadId = '30000000-0000-0000-0000-000000000002'
    incoming(old, { v: 1, type: 'upload.open', id: uploadId, fence: old.fence, sessionId: 's', name: 'f', mediaType: 'text/plain', bytes: 1 })
    old.fromHost(Buffer.from(JSON.stringify({ v: 1, type: 'upload.credit', id: uploadId, fence: old.fence, chunks: 1 })), false)
    old.receive(Buffer.from(encodeChunk(uploadId, old.fence!.controlId, 0, new Uint8Array([1]))), true); const chunk = queued.at(-1)!
    old.fromHost(Buffer.from(JSON.stringify({ v: 1, type: 'result', id: commandId, fence: old.fence, result: { ok: true, value: { accepted: true } } })), false); const result = browserFrames.at(-1)!
    next = new BrowserSocket(instanceId, 'owned-cookie', host, transport, auth, leases, { heartbeatMs: 10000, leaseTtlMs: 30000 }, () => {}, () => {}, () => old.fail('REMOTE_REPLACED'))
    incoming(next, { v: 1, type: 'browser.hello', versions: [1], takeover: true })
    expect(mutation.guard).toThrow('STALE_CONTROL'); expect(chunk.guard).toThrow('STALE_CONTROL'); expect(result.guard).toThrow('STALE_CONTROL')
    old.disconnected(); incoming(old, { v: 1, type: 'heartbeat', fence: old.fence }); old.receive(Buffer.from(encodeChunk(uploadId, old.fence!.controlId, 0, new Uint8Array([1]))), true)
    expect(leases.get(instanceId)?.controlId).toBe(next.fence!.controlId)
    expect(queued.filter(f => f.value.type === 'detach')).toHaveLength(1)
    expect(queued.filter(f => f.value.type === 'call')).toHaveLength(1)
    expect(queued.some(f => f.value.type === 'cancel')).toBe(false)
  } finally { old.disconnected(); next?.disconnected() }
})
