import { expect, test } from 'vitest'
import { fixture, instanceId } from './socket-fixture.ts'
test('untrusted origin cannot exchange a link; healthy DB needs no Host', async () => {
  const f = await fixture()
  try {
    expect(
      (
        await f.post(
          `/v1/instances/${instanceId}/login`,
          { secret: 'link-a' },
          { Origin: 'https://evil.test' },
        )
      ).status,
    ).toBe(403)
    expect((await fetch(f.http() + '/health/ready')).status).toBe(200)
  } finally {
    await f.close()
  }
})
test('unauthenticated upgrades and wrong instance routing are rejected before open', async () => {
  const f = await fixture()
  try {
    await f.register()
    const cookie = await f.login()
    const a = f.socket('/v1/host', { Cookie: cookie })
    await expect(a.open()).rejects.toThrow('401')
    const b = f.socket(`/v1/instances/${instanceId}/control`, {
      Cookie: cookie,
      Origin: 'https://evil.test',
    })
    await expect(b.open()).rejects.toThrow('403')
    const c = f.socket(
      '/v1/instances/10000000-0000-0000-0000-000000000002/control',
      { Cookie: cookie, Origin: f.config.publicOrigin },
    )
    await expect(c.open()).rejects.toThrow('401')
  } finally {
    await f.close()
  }
})
test('static entry has hardened headers; only fingerprint assets cache; auth body bound', async () => {
  const f = await fixture()
  try {
    const index = await fetch(f.http() + '/')
    expect(index.headers.get('cache-control')).toBe('no-store')
    expect(index.headers.get('content-security-policy')).toContain(
      "frame-ancestors 'none'",
    )
    expect(index.headers.get('x-content-type-options')).toBe('nosniff')
    expect(index.headers.get('referrer-policy')).toBe('no-referrer')
    expect(
      (
        await f.post(`/v1/instances/${instanceId}/login`, {
          secret: 'x'.repeat(5000),
        })
      ).status,
    ).toBe(413)
    expect((await fetch(f.http() + '/attachments/a.html')).status).toBe(404)
  } finally {
    await f.close()
  }
})
test('logout deletes the browser session and invalidates its active control', async () => {
  const f = await fixture()
  try {
    await f.register()
    const cookie = await f.login()
    const h = await f.host()
    await h.next('relay.ack')
    const { b } = await f.attach(h, cookie)
    expect(
      (
        await f.post(
          `/v1/instances/${instanceId}/logout`,
          {},
          { Cookie: cookie },
        )
      ).status,
    ).toBe(200)
    expect((await b.next('fault')).error.code).toBe('AUTH_REVOKED')
    const denied = f.socket(`/v1/instances/${instanceId}/control`, {
      Cookie: cookie,
      Origin: f.config.publicOrigin,
    })
    await expect(denied.open()).rejects.toThrow('401')
  } finally {
    await f.close()
  }
})
test('unauthenticated HTTP admission is capped and auth attempts are rate limited', async () => {
  const { createConnection } = await import('node:net')
  const f = await fixture()
  const sockets: ReturnType<typeof createConnection>[] = []
  try {
    const port = Number(new URL(f.http()).port)
    let closed = 0
    await Promise.all(
      Array.from(
        { length: 70 },
        () =>
          new Promise<void>((resolve) => {
            const s = createConnection({ host: '127.0.0.1', port })
            sockets.push(s)
            s.on('error', () => {})
            s.on('close', () => closed++)
            s.once('connect', resolve)
          }),
      ),
    )
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(closed).toBeGreaterThanOrEqual(6)
    for (const s of sockets) s.destroy()
    await new Promise((resolve) => setTimeout(resolve, 25))
    let status = 0
    for (let i = 0; i < 61; i++)
      status = (
        await f.post(`/v1/instances/${instanceId}/login`, { secret: 'invalid' })
      ).status
    expect(status).toBe(429)
  } finally {
    for (const s of sockets) s.destroy()
    await f.close()
  }
})
test('slow static response cannot write a second header block or kill health', async () => {
  const { mkdir, writeFile } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const { createConnection } = await import('node:net')
  const f = await fixture()
  let socket: ReturnType<typeof createConnection> | undefined
  try {
    await mkdir(join(f.config.staticDir, 'assets'))
    await writeFile(
      join(f.config.staticDir, 'assets/bundle.12345678.js'),
      Buffer.alloc(16 * 1024 * 1024, 32),
    )
    socket = createConnection({
      host: '127.0.0.1',
      port: Number(new URL(f.http()).port),
    })
    socket.on('error', () => {})
    await new Promise<void>((resolve) => socket!.once('connect', resolve))
    socket.write(
      'GET /assets/bundle.12345678.js HTTP/1.1\r\nHost: localhost\r\n\r\n',
    )
    socket.pause()
    await new Promise((resolve) => setTimeout(resolve, 5300))
    expect((await fetch(f.http() + '/health/ready')).status).toBe(200)
  } finally {
    socket?.destroy()
    await f.close()
  }
}, 8000)

test('control-status reports authenticated offline/online/busy without issuing cookies or acquiring a lease', async () => {
  const f = await fixture()
  try {
    await f.register(); const cookie = await f.login(); const route = `/v1/instances/${instanceId}/control-status`
    expect((await f.post(route, {}, { Cookie: cookie, Origin: 'https://evil.test' })).status).toBe(403)
    expect((await f.post(route, {})).status).toBe(401)
    const offline = await f.post(route, {}, { Cookie: cookie }); expect(offline.status).toBe(200); expect(await offline.json()).toEqual({ hostOnline: false, remoteConnected: false })
    expect(offline.headers.get('set-cookie')).toBeNull(); expect(offline.headers.get('cache-control')).toBe('no-store'); expect(offline.headers.get('access-control-allow-origin')).toBeNull()
    const h = await f.host(); await h.next('relay.ack')
    expect(await (await f.post(route, {}, { Cookie: cookie })).json()).toEqual({ hostOnline: true, remoteConnected: false })
    const { b } = await f.attach(h, cookie)
    expect(await (await f.post(route, {}, { Cookie: cookie })).json()).toEqual({ hostOnline: true, remoteConnected: true })
    expect(b.ws.readyState).toBe(1)
  } finally { await f.close() }
})
test('control-status identifies fixed cookie expiry and does not renew stored authorization', async () => {
  const f = await fixture()
  try {
    await f.register(); const cookie = await f.login(); const { default: Database } = await import('better-sqlite3'); const db = new Database(f.config.databasePath)
    try { db.prepare('UPDATE browser_sessions SET expires_at = ?').run(Date.now() - 1) } finally { db.close() }
    const response = await f.post(`/v1/instances/${instanceId}/control-status`, {}, { Cookie: cookie }); expect(response.status).toBe(401); expect((await response.json()).error.code).toBe('AUTH_EXPIRED'); expect(response.headers.get('set-cookie')).toBeNull()
  } finally { await f.close() }
})

test('canonical connect entry keeps session query and served CSP without widening API or asset routes', async () => {
  const f = await fixture()
  try {
    const root = await fetch(f.http() + '/')
    const entry = await fetch(f.http() + `/connect/${instanceId}?session=a&detail=record`)
    expect(entry.status).toBe(200)
    expect(await entry.text()).toBe(await root.text())
    expect(entry.headers.get('cache-control')).toBe('no-store')
    expect(entry.headers.get('content-security-policy')).toContain("img-src 'self' data: blob:")
    for (const path of ['/connect/not-an-id', `/connect/${instanceId}/extra`, '/assets/../private', '/arbitrary?session=a', `/v1/instances/${instanceId}/control-status?extra=1`]) expect((await fetch(f.http() + path)).status).not.toBe(200)
  } finally { await f.close() }
})
test('readiness tracks missing index and referenced hashed assets while liveness remains available', async () => {
  const { writeFile, mkdir, unlink } = await import('node:fs/promises'); const { join } = await import('node:path')
  const f = await fixture()
  try {
    await writeFile(join(f.config.staticDir, 'index.html'), '<script src="/assets/main-12345678.js"></script>')
    expect((await fetch(f.http() + '/health/ready')).status).toBe(503)
    await mkdir(join(f.config.staticDir, 'assets')); await writeFile(join(f.config.staticDir, 'assets/main-12345678.js'), 'void 0')
    expect((await fetch(f.http() + '/health/ready')).status).toBe(200)
    await unlink(join(f.config.staticDir, 'assets/main-12345678.js')); expect((await fetch(f.http() + '/health/ready')).status).toBe(503)
    await unlink(join(f.config.staticDir, 'index.html')); expect((await fetch(f.http() + '/health/ready')).status).toBe(503)
    expect((await fetch(f.http() + '/health/live')).status).toBe(200)
  } finally { await f.close() }
})
