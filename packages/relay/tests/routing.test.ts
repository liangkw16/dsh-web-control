import { expect, test } from 'vitest'
import { fixture, hello, delay } from './socket-fixture.ts'
test('Host matching ACK is required before ready and failed initial delivery releases lease', async () => {
  const f = await fixture()
  try {
    await f.register()
    const cookie = await f.login()
    const h = await f.host()
    await h.next('relay.ack')
    const lost = await f.browser(cookie)
    await lost.next('browser.lease')
    await lost.close()
    await delay(20)
    const b = await f.browser(cookie)
    const lease = await b.next('browser.lease')
    b.send({ v: 1, type: 'browser.lease-ack', id: lease.id })
    const a = await h.next('attach')
    await delay(20)
    expect(b.messages.some((m) => m.type === 'ready')).toBe(false)
    h.send({ v: 1, type: 'host.attached', id: a.id, fence: a.fence })
    expect((await b.next('ready')).fence).toEqual(a.fence)
  } finally {
    await f.close()
  }
})
test('higher epoch duplicate Host cannot mutate active authorization', async () => {
  const f = await fixture()
  try {
    await f.register()
    const cookie = await f.login()
    const h = await f.host()
    await h.next('relay.ack')
    const duplicate = await f.host({ ...hello, authEpoch: 2 })
    expect((await duplicate.next('fault')).error.code).toBe('HOST_ID_IN_USE')
    await f.attach(h, cookie)
  } finally {
    await f.close()
  }
})
test('confirmed disconnect resumes with a fresh Fence; stale late ACK and events cannot hijack it', async () => {
  const f = await fixture()
  try {
    await f.register()
    const cookie = await f.login()
    const h = await f.host()
    await h.next('relay.ack')
    const old = await f.attach(h, cookie)
    await old.b.close()
    await h.next('detach')
    const b = await f.browser(cookie, {
      id: old.lease.id,
      secret: old.lease.resumeSecret,
    })
    const lease = await b.next('browser.lease')
    expect(lease.id).toBe(old.lease.id)
    expect(lease.fence.controlId).not.toBe(old.fence.controlId)
    b.send({ v: 1, type: 'browser.lease-ack', id: lease.id })
    const attach = await h.next('attach')
    h.send({
      v: 1,
      type: 'host.attached',
      id: '30000000-0000-0000-0000-000000000001',
      fence: old.fence,
    })
    await delay(15)
    expect(b.messages.some((m) => m.type === 'ready')).toBe(false)
    h.send({ v: 1, type: 'host.attached', id: attach.id, fence: attach.fence })
    await b.next('ready')
    h.send({
      v: 1,
      type: 'event',
      id: '30000000-0000-0000-0000-000000000002',
      fence: old.fence,
      value: 'old',
    })
    await delay(20)
    expect(
      b.messages.some((m) => m.type === 'event' || m.type === 'fault'),
    ).toBe(false)
  } finally {
    await f.close()
  }
})
test('pending attach expires with lease, late ACK does not ready the next control', async () => {
  const f = await fixture({ heartbeatMs: 20, leaseTtlMs: 100 })
  try {
    await f.register()
    const cookie = await f.login()
    const h = await f.host()
    await h.next('relay.ack')
    const b = await f.browser(cookie)
    const lease = await b.next('browser.lease')
    b.send({ v: 1, type: 'browser.lease-ack', id: lease.id })
    const old = await h.next('attach')
    expect((await b.next('fault')).error.code).toBe('STALE_CONTROL')
    const next = await f.browser(cookie)
    const fresh = await next.next('browser.lease')
    next.send({ v: 1, type: 'browser.lease-ack', id: fresh.id })
    const attach = await h.next('attach')
    h.send({ v: 1, type: 'host.attached', id: old.id, fence: old.fence })
    await delay(10)
    expect(next.messages.some((m) => m.type === 'ready')).toBe(false)
    h.send({ v: 1, type: 'host.attached', id: attach.id, fence: attach.fence })
    await next.next('ready')
  } finally {
    await f.close()
  }
})
test('ping/pong alone does not renew business lease; heartbeat does', async () => {
  const f = await fixture({ heartbeatMs: 20, leaseTtlMs: 120 })
  try {
    await f.register()
    const cookie = await f.login()
    const h = await f.host()
    await h.next('relay.ack')
    const { b, fence } = await f.attach(h, cookie)
    for (let i = 0; i < 3; i++) {
      await delay(60)
      b.send({ v: 1, type: 'heartbeat', fence })
    }
    expect(b.messages.some((m) => m.type === 'fault')).toBe(false)
    expect((await b.next('fault')).error.code).toBe('STALE_CONTROL')
    expect(h.messages.some((m) => m.type === 'cancel')).toBe(false)
  } finally {
    await f.close()
  }
})
test('authenticated epoch change revokes pending and active business routes without cancel', async () => {
  const f = await fixture()
  try {
    await f.register()
    const cookie = await f.login()
    const h = await f.host()
    await h.next('relay.ack')
    const { b, fence } = await f.attach(h, cookie)
    b.send({
      v: 1,
      type: 'call',
      id: '30000000-0000-0000-0000-000000000003',
      fence,
      command: {
        op: 'session.prompt',
        sessionId: 's',
        requestId: '40000000-0000-0000-0000-000000000003',
        mode: 'queue',
        content: [{ kind: 'text', text: 'accepted-work' }],
      },
    })
    await h.next('call')
    h.send({
      v: 1,
      type: 'host.auth',
      authEpoch: 2,
      linkVerifier: hello.linkVerifier,
      enabled: true,
    })
    expect((await h.next('relay.ack')).authEpoch).toBe(2)
    expect((await b.next('fault')).error.code).toBe('AUTH_REVOKED')
    await h.next('detach')
    expect(h.messages.some((m) => m.type === 'cancel')).toBe(false)
  } finally {
    await f.close()
  }
})
test('browser cannot send Host auth or bypass lease/attach state', async () => {
  const f = await fixture()
  try {
    await f.register()
    const cookie = await f.login()
    const h = await f.host()
    await h.next('relay.ack')
    const b = await f.browser(cookie)
    await b.next('browser.lease')
    b.send({
      v: 1,
      type: 'host.auth',
      authEpoch: 2,
      linkVerifier: hello.linkVerifier,
      enabled: false,
    })
    expect((await b.next('fault')).error.code).toBe('INVALID_MESSAGE')
    const next = await f.attach(h, cookie)
    expect(next.fence.authEpoch).toBe(1)
  } finally {
    await f.close()
  }
})
test('Host-advertised limits are clamped and advertised to both roles', async () => {
  const f = await fixture()
  try {
    await f.register()
    const cookie = await f.login()
    const h = await f.host({
      ...hello,
      limits: { ...f.config.limits, calls: 2 },
    } as typeof hello)
    await h.next('relay.ack')
    expect((await h.next('relay.config')).limits.calls).toBe(2)
    const b = await f.browser(cookie)
    const config = await b.next('relay.config')
    expect(Object.keys(config).sort()).toEqual([
      'heartbeatMs',
      'leaseTtlMs',
      'limits',
      'type',
      'v',
    ])
    expect(config.limits.calls).toBe(2)
    expect(config.heartbeatMs).toBe(f.config.heartbeatMs)
    expect(config.leaseTtlMs).toBe(f.config.leaseTtlMs)
  } finally {
    await f.close()
  }
})
test('wrong Fence ACK fails attach and releases lease', async () => {
  const f = await fixture()
  try {
    await f.register()
    const cookie = await f.login()
    const h = await f.host()
    await h.next('relay.ack')
    const b = await f.browser(cookie)
    const lease = await b.next('browser.lease')
    b.send({ v: 1, type: 'browser.lease-ack', id: lease.id })
    const a = await h.next('attach')
    h.send({
      v: 1,
      type: 'host.attached',
      id: a.id,
      fence: { ...a.fence, authEpoch: 2 },
    })
    expect((await b.next('fault')).error.code).toBe('STALE_CONTROL')
    await f.attach(h, cookie)
  } finally {
    await f.close()
  }
})
test('lost lease acknowledgment times out and a fresh page can acquire', async () => {
  const f = await fixture({ heartbeatMs: 20, leaseTtlMs: 100 })
  try {
    await f.register()
    const cookie = await f.login()
    const h = await f.host()
    await h.next('relay.ack')
    const b = await f.browser(cookie)
    await b.next('browser.lease')
    expect((await b.next('fault')).error.code).toBe('STALE_CONTROL')
    await f.attach(h, cookie)
  } finally {
    await f.close()
  }
})
test('Host ACK has its own ten-second deadline and failure releases ownership', async () => {
  const f = await fixture()
  try {
    await f.register()
    const cookie = await f.login()
    const h = await f.host()
    await h.next('relay.ack')
    const b = await f.browser(cookie)
    const lease = await b.next('browser.lease')
    b.send({ v: 1, type: 'browser.lease-ack', id: lease.id })
    await h.next('attach')
    expect((await b.next('fault', 11000)).error.code).toBe('HOST_OFFLINE')
    await f.attach(h, cookie)
  } finally {
    await f.close()
  }
}, 15000)
