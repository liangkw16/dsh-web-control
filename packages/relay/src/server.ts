import { selectUiProfile } from './ui-profiles.ts'
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { resolve, relative, extname } from 'node:path'
import type { Socket } from 'node:net'
import WebSocket, { WebSocketServer } from 'ws'
import {
  ProtocolError,
  effectiveLimits,
  negotiate,
  parseHandshake,
  parseHost,
  decodeChunk,
  checkJsonLength,
  hostUiProfileFromCapabilities,
} from '@dsh-web-control/protocol'
import { staticReadiness } from './static-readiness.ts'
import {loadUiRelease,serveUiAsset} from './ui-assets.ts'
import { AuthStore } from './auth.ts'
import { assertOrigin, cookieName, sessionCookie } from './origin.ts'
import { LeaseTable } from './leases.ts'
import { HostRoutes } from './host-routes.ts'
import {
  AUTH_BODY_BYTES,
  HANDSHAKE_MS,
  MAX_UNAUTHENTICATED,
  validateConfig,
  type RelayConfig,
} from './config.ts'
import { log, fault } from './logging.ts'
import { TransportGroup } from './transport.ts'
import { HostSocket } from './host-socket.ts'
import { BrowserSocket } from './browser-socket.ts'
export type { RelayConfig } from './config.ts'
const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data: blob:; frame-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
}
function cookie(request: IncomingMessage, instanceId: string): string {
  const name = cookieName(instanceId),
    values = (request.headers.cookie ?? '')
      .split(';')
      .map((v) => v.trim())
      .filter((v) => v.startsWith(name + '='))
  if (values.length !== 1) throw new ProtocolError('AUTH_REQUIRED')
  return values[0].slice(name.length + 1)
}
function status(code: string): number {
  return code === 'ORIGIN_DENIED'
    ? 403
    : code === 'LIMIT_EXCEEDED'
      ? 413
      : code === 'RATE_LIMITED'
        ? 429
        : code.startsWith('AUTH_')
          ? 401
          : code === 'STORAGE_ERROR'
            ? 503
            : code === 'NOT_FOUND'
              ? 404
              : 400
}
function response(
  res: ServerResponse,
  code: number,
  value: unknown,
  headers: Record<string, string> = {},
): void {
  res.writeHead(code, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json',
    ...headers,
  })
  res.end(JSON.stringify(value))
}
async function body(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  if (request.headers['content-type'] !== 'application/json')
    throw new ProtocolError('INVALID_MESSAGE')
  if (Number(request.headers['content-length'] ?? 0) > AUTH_BODY_BYTES)
    throw new ProtocolError('LIMIT_EXCEEDED')
  let bytes = 0
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    bytes += chunk.length
    if (bytes > AUTH_BODY_BYTES) throw new ProtocolError('LIMIT_EXCEEDED')
    chunks.push(chunk)
  }
  let value: unknown
  try {
    value = JSON.parse(Buffer.concat(chunks).toString())
  } catch {
    throw new ProtocolError('INVALID_MESSAGE')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ProtocolError('INVALID_MESSAGE')
  return value as Record<string, unknown>
}
function keys(value: Record<string, unknown>, expected: string[]): void {
  if (
    Object.keys(value).length !== expected.length ||
    expected.some((k) => !Object.hasOwn(value, k))
  )
    throw new ProtocolError('INVALID_MESSAGE')
}
export async function startRelay(
  input: RelayConfig,
): Promise<{ port: number; metrics(): { bufferedBytes: number; peakBufferedBytes: number }; close(): Promise<void> }> {
  const config = validateConfig(input)
  if(config.nativeUiReleases===undefined){try{const release=await loadUiRelease(config.staticDir);if(release)config.nativeUiReleases=release.manifest.native.map(({dshVersion,adapter,revision})=>({dshVersion,adapter,revision}))}catch{/* Readiness stays unavailable; do not advertise an unverified UI. */}}
  const auth = new AuthStore(
      config.databasePath,
      { now: Date.now },
      config.enrollmentVerifier,
    ),
    leases = new LeaseTable({ now: Date.now }, config.leaseTtlMs),
    routes = new HostRoutes()
  const groups = new Set<TransportGroup>()
  let retiredPeak = 0, reconnects = 0
  const hosts = new Map<string, HostSocket>(),
    browsers = new Map<string, BrowserSocket>(),
    sockets = new Set<Socket>(),
    untrusted = new Set<Socket>(),
    handshakes = new Set<WebSocket>(),
    websockets = new Set<WebSocket>(),
    admissionTimers = new WeakMap<Socket, NodeJS.Timeout>()
  let closing = false,
    attempts = 0,
    attemptWindow = Date.now()
  const rate = () => {
    const now = Date.now()
    if (now - attemptWindow >= 60000) {
      attempts = 0
      attemptWindow = now
    }
    if (++attempts > 60) throw new ProtocolError('RATE_LIMITED')
  }
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: Math.max(
      config.limits.jsonBytes,
      44 + config.limits.chunkBytes,
    ),
    perMessageDeflate: false,
  })
  const terminateHost = (host: HostSocket, code: string) => {
    if (hosts.get(host.instanceId) !== host) return
    hosts.delete(host.instanceId)
    host.abort(code)
    browsers.get(host.instanceId)?.fail(code)
    host.transport.close(code === 'LIMIT_EXCEEDED' ? 1009 : 1008, code)
    // Preserve one instance budget/route until every old socket actually closes.
    host.group.retire(() => { retiredPeak = Math.max(retiredPeak, host.group.peakRetainedBytes); groups.delete(host.group); routes.remove(host.instanceId, host.socketId) })
  }
  const checkStatic = staticReadiness(config.staticDir)
  const server = createServer(
    {
      requestTimeout: HANDSHAKE_MS,
      headersTimeout: HANDSHAKE_MS,
      maxHeaderSize: 8192,
    },
    (request, res) => {
      const timer = setTimeout(() => {
        if (res.destroyed || res.writableEnded) return
        if (!res.headersSent)
          response(res, 408, { error: { code: 'HANDSHAKE_TIMEOUT' } })
        else res.destroy()
        request.socket.destroy()
      }, HANDSHAKE_MS)
      res.once('close', () => clearTimeout(timer))
      void (async () => {
        const path = request.url ?? ''
        if (
          request.method === 'GET' &&
          (path === '/health/live' || path === '/health/ready')
        ) {
          if (path === '/health/ready') { await checkStatic(); auth.check() }
          response(res, 200, { ok: true })
          return
        }
        if (request.method === 'POST' && path === '/v1/devices/register') {
          rate()
          const value = await body(request)
          keys(value, [
            'enrollmentSecret',
            'instanceId',
            'deviceSecret',
            'linkVerifier',
            'authEpoch',
          ])
          auth.register(
            value as unknown as Parameters<AuthStore['register']>[0],
          )
          response(res, 201, { ok: true })
          return
        }
        const profileMatch = /^\/v1\/instances\/([0-9a-f-]+)\/ui-profile$/.exec(path)
        if (request.method === 'GET' && profileMatch) {
          const id = profileMatch[1]
          auth.authorize(id, cookie(request, id))
          const host = hosts.get(id)
          host?.current()
          response(res, 200, host ? selectUiProfile(host.uiProfile, host.runtimeId, config.nativeUiReleases ?? []) : { kind: 'unavailable', code: 'HOST_OFFLINE' })
          return
        }
        const match = /^\/v1\/instances\/([0-9a-f-]+)\/(login|logout|control-status)$/.exec(
          path,
        )
        if (request.method === 'POST' && match) {
          assertOrigin(request.headers.origin, config.publicOrigin)
          rate()
          const [, id, action] = match
          if (action === 'control-status') {
            const value = await body(request)
            keys(value, [])
            auth.authorize(id, cookie(request, id))
            const host = hosts.get(id)
            host?.current()
            response(res, 200, { hostOnline: !!host, remoteConnected: browsers.has(id) })
          } else if (action === 'login') {
            const value = await body(request)
            keys(value, ['secret'])
            const login = auth.login(id, value.secret as string)
            response(
              res,
              200,
              { expiresAt: login.expiresAt },
              { 'Set-Cookie': sessionCookie(id, login.sessionToken) },
            )
          } else {
            const token = cookie(request, id)
            auth.logout(id, token)
            const browser = browsers.get(id)
            if (browser?.token === token) browser.fail('AUTH_REVOKED')
            response(
              res,
              200,
              { ok: true },
              {
                'Set-Cookie': `${cookieName(id)}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`,
              },
            )
          }
          return
        }
        const served=await serveUiAsset(config.staticDir,request,res)
        if(served!==undefined){if(!served)throw new ProtocolError('NOT_FOUND');return}
        const staticPath = path.split('?')[0]!
        if (
          request.method === 'GET' &&
          (staticPath === '/' ||
            staticPath === '/index.html' ||
            /^\/connect\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(staticPath) ||
            /^\/assets\/[A-Za-z0-9_.-]+$/.test(staticPath))
        ) {
          const root = await realpath(config.staticDir),
            file = await realpath(
              resolve(root, staticPath === '/' || staticPath.startsWith('/connect/') ? 'index.html' : staticPath.slice(1)),
            )
          if (relative(root, file).startsWith('..'))
            throw new ProtocolError('NOT_FOUND')
          const info = await stat(file)
          if (!info.isFile()) throw new ProtocolError('NOT_FOUND')
          const types: Record<string, string> = {
            '.html': 'text/html; charset=utf-8',
            '.js': 'text/javascript; charset=utf-8',
            '.css': 'text/css; charset=utf-8',
            '.svg': 'image/svg+xml',
            '.png': 'image/png',
            '.woff2': 'font/woff2',
          }
          const cache =
            /^\/assets\/[^/]+[.-][a-zA-Z0-9_-]{8,}\.(js|css|png|woff2)$/.test(
              path,
            )
              ? 'public, max-age=31536000, immutable'
              : 'no-store'
          res.writeHead(200, {
            ...SECURITY_HEADERS,
            'Cache-Control': cache,
            'Content-Type': types[extname(file)] ?? 'application/octet-stream',
            'Content-Length': String(info.size),
          })
          const stream = createReadStream(file)
          res.once('close', () => stream.destroy())
          stream.on('error', () => res.destroy())
          stream.pipe(res)
          return
        }
        throw new ProtocolError('NOT_FOUND')
      })().catch((error) => {
        const errorFault = fault(error)
        log({ level: 'error', event: 'http.rejected', code: errorFault.code })
        if (!res.headersSent)
          response(
            res,
            status(errorFault.code),
            { error: errorFault },
            { Connection: 'close' },
          )
        else res.destroy()
      })
    },
  )
  server.keepAliveTimeout = HANDSHAKE_MS
  server.on('connection', (socket) => {
    if (untrusted.size >= MAX_UNAUTHENTICATED) {
      socket.destroy()
      return
    }
    sockets.add(socket)
    untrusted.add(socket)
    // Absolute pre-upgrade deadline: trickled headers must not renew admission.
    admissionTimers.set(
      socket,
      setTimeout(() => socket.destroy(), HANDSHAKE_MS),
    )
    socket.setTimeout(HANDSHAKE_MS, () => socket.destroy())
    socket.once('close', () => {
      clearTimeout(admissionTimers.get(socket))
      sockets.delete(socket)
      untrusted.delete(socket)
    })
  })
  server.on('clientError', (_error, socket) => socket.destroy())
  server.on('upgrade', (request, socket, head) => {
    try {
      if (closing) throw new ProtocolError('HOST_OFFLINE')
      const path = request.url ?? ''
      if (path === '/v1/host') {
        if (handshakes.size >= MAX_UNAUTHENTICATED)
          throw new ProtocolError('RATE_LIMITED')
        const id = request.headers['x-dsh-instance'],
          header = request.headers.authorization
        if (
          typeof id !== 'string' ||
          typeof header !== 'string' ||
          !header.startsWith('Bearer ')
        )
          throw new ProtocolError('AUTH_REQUIRED')
        const secret = header.slice(7)
        auth.authenticateDevice(id, secret)
        wss.handleUpgrade(request, socket, head, (ws) => {
          clearTimeout(admissionTimers.get(socket as Socket))
          untrusted.delete(socket as Socket)
          ;(socket as Socket).setTimeout(0)
          handshakes.add(ws)
          websockets.add(ws)
          let host: HostSocket | undefined
          const bootstrap = new TransportGroup(config.limits, () =>
              ws.terminate(),
            ),
            initial = bootstrap.add(ws)
          const timer = setTimeout(
            () => reject(new ProtocolError('HANDSHAKE_TIMEOUT')),
            HANDSHAKE_MS,
          )
          const reject = (error: unknown) => {
            const f = fault(error)
            log({
              level: 'error',
              event: 'host.rejected',
              instanceId: id,
              code: f.code,
            })
            try {
              ;(host?.transport ?? initial).send({
                v: 1,
                type: 'fault',
                error: f,
              })
            } catch {}
            setImmediate(() => {
              if (host) terminateHost(host!, f.code)
              else
                initial.close(f.code === 'LIMIT_EXCEEDED' ? 1009 : 1008, f.code)
            })
          }
          ws.on('error', () => reject(new ProtocolError('LIMIT_EXCEEDED')))
          ws.on('close', () => {
            websockets.delete(ws)
            clearTimeout(timer)
            handshakes.delete(ws)
            bootstrap.dispose()
            if (host) terminateHost(host, 'HOST_OFFLINE')
          })
          ws.on('message', (raw, binary) => {
            const data = Buffer.isBuffer(raw)
              ? raw
              : Buffer.from(raw as ArrayBuffer)
            try {
              if (!host) {
                if (binary) throw new ProtocolError('INVALID_MESSAGE')
                const hello = parseHandshake(data.toString(), config.limits)
                if (hello.type !== 'host.hello' || hello.instanceId !== id)
                  throw new ProtocolError('INVALID_MESSAGE')
                negotiate(hello.versions, [1])
                const uiProfile = hostUiProfileFromCapabilities(hello.capabilities)
                const socketId = randomUUID()
                routes.claim(id, hello.runtimeId, socketId) // must precede persistent epoch mutation
                try {
                  auth.syncAuthorization(
                    id,
                    secret,
                    hello.authEpoch,
                    hello.linkVerifier,
                    hello.enabled,
                  )
                  const limits = effectiveLimits(
                    config.limits,
                    hello.limits ?? {},
                  )
                  const group = new TransportGroup(limits, (code) => {
                    if (host) terminateHost(host, code)
                  })
                  groups.add(group)
                  host = new HostSocket(
                    id,
                    hello.runtimeId,
                    socketId,
                    hello.authEpoch,
                    limits,
                    group.add(ws),
                    group,
                    () => {
                      if (
                        hosts.get(id) !== host ||
                        routes.get(id)?.socketId !== socketId
                      )
                        throw new ProtocolError('HOST_OFFLINE')
                      const current = auth.current(id)
                      if (current.authEpoch !== host!.authEpoch)
                        throw new ProtocolError('AUTH_REVOKED')
                    },
                    uiProfile,
                  )
                  hosts.set(id, host)
                  clearTimeout(timer)
                  handshakes.delete(ws)
                  bootstrap.dispose()
                  host.transport.send({
                    v: 1,
                    type: 'relay.ack',
                    version: 1,
                    ...auth.current(id),
                  })
                  host.transport.send({
                    v: 1,
                    type: 'relay.config',
                    limits,
                    heartbeatMs: config.heartbeatMs,
                    leaseTtlMs: config.leaseTtlMs,
                  })
                } catch (error) {
                  routes.remove(id, socketId)
                  throw error
                }
                return
              }
              host.current()
              if (!binary) {
                // Handshake parsing is tried only for known central message discriminators;
                // full strict parsing still owns all fields and role/state allowlists.
                checkJsonLength(data.toString(), host.limits.jsonBytes)
                let type: unknown
                try {
                  type = JSON.parse(data.toString()).type
                } catch {
                  throw new ProtocolError('INVALID_MESSAGE')
                }
                if (type === 'host.attached' || type === 'host.auth') {
                  const message = parseHandshake(data.toString(), host.limits)
                  if (message.type === 'host.attached') host.attached(message)
                  else if (message.type === 'host.auth') {
                    auth.syncAuthorization(
                      id,
                      secret,
                      message.authEpoch,
                      message.linkVerifier,
                      message.enabled,
                    )
                    if (message.authEpoch !== host.authEpoch) {
                      host.authEpoch = message.authEpoch
                      host.abort('AUTH_REVOKED')
                      browsers.get(id)?.fail('AUTH_REVOKED')
                      const lease = leases.get(id)
                      if (lease) leases.release(id, lease.controlId)
                    }
                    host.transport.send({
                      v: 1,
                      type: 'relay.ack',
                      version: 1,
                      ...auth.current(id),
                    })
                  }
                  return
                }
              }
              if (binary) decodeChunk(data, host.limits)
              else parseHost(data.toString(), host.limits)
              browsers.get(id)?.fromHost(data, binary)
            } catch (error) {
              reject(error)
            }
          })
        })
        return
      }
      const match = /^\/v1\/instances\/([0-9a-f-]+)\/control$/.exec(path)
      if (!match) throw new ProtocolError('NOT_FOUND')
      assertOrigin(request.headers.origin, config.publicOrigin)
      const id = match[1],
        token = cookie(request, id)
      auth.authorize(id, token)
      const host = hosts.get(id)
      if (!host) throw new ProtocolError('HOST_OFFLINE')
      host.current()
      if (handshakes.size >= MAX_UNAUTHENTICATED) throw new ProtocolError('RATE_LIMITED')
      const browserWss = new WebSocketServer({
        noServer: true,
        maxPayload: Math.max(
          host.limits.jsonBytes,
          44 + host.limits.chunkBytes,
        ),
        perMessageDeflate: false,
      })
      browserWss.handleUpgrade(request, socket, head, (ws) => {
        websockets.add(ws)
        clearTimeout(admissionTimers.get(socket as Socket))
        untrusted.delete(socket as Socket)
        ;(socket as Socket).setTimeout(0)
        // Until a strict, negotiated hello claims a lease, this socket has its own
        // bounded budget and cannot exhaust or evict the existing controller.
        handshakes.add(ws)
        const bootstrap = new TransportGroup(host.limits, code => browser.fail(code))
        const transport = bootstrap.add(ws)
        const browser = new BrowserSocket(
          id,
          token,
          host,
          transport,
          auth,
          leases,
          config,
          () => {
            if (browsers.get(id) === browser) browsers.delete(id)
          },
          () => { reconnects = Math.min(Number.MAX_SAFE_INTEGER, reconnects + 1) },
          () => {
            // acquire already fenced the old owner; detach cancels only its remote
            // observers/transfers and aborts a matching pending Host attach.
            browsers.get(id)?.fail('REMOTE_REPLACED')
            browsers.set(id, browser)
            browser.transport = host.group.add(ws)
            handshakes.delete(ws)
            bootstrap.dispose()
          },
          config.nativeUiReleases,
        )
        ws.on('error', () => browser.fail('LIMIT_EXCEEDED'))
        ws.on('message', (raw, binary) =>
          browser.receive(
            Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer),
            binary,
          ),
        )
        ws.on('close', () => {
          websockets.delete(ws)
          handshakes.delete(ws)
          bootstrap.dispose()
          browser.disconnected()
          browser.transport.close(1000)
          browserWss.close()
        })
      })
    } catch (error) {
      const f = fault(error)
      log({ level: 'error', event: 'upgrade.rejected', code: f.code })
      socket.end(
        `HTTP/1.1 ${status(f.code)} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
      )
    }
  })
  const alive = new WeakMap<WebSocket, boolean>()
  const pingAt = new WeakMap<WebSocket, number>()
  let rttMs = 0, rttSamples = 0
  // Install ping state lazily during sweep; pong never renews the business lease.
  let lastPing = Date.now()
  const sweep = setInterval(
    () => {
      const now = Date.now()
      leases.sweepExpired()
      for (const browser of browsers.values()) browser.sweep(now)
      for (const host of hosts.values()) {
        try {
          host.current()
        } catch (error) {
          terminateHost(host, fault(error).code)
        }
      }
      if (now - lastPing >= config.heartbeatMs) {
        lastPing = now
        for (const ws of websockets) {
          if (alive.get(ws) === false) {
            ws.terminate()
            continue
          }
          if (!alive.has(ws)) ws.on('pong', () => { alive.set(ws, true); const sent = pingAt.get(ws); if (sent !== undefined) { rttMs = Math.max(0, Date.now() - sent); rttSamples = Math.min(Number.MAX_SAFE_INTEGER, rttSamples + 1); pingAt.delete(ws) } })
          alive.set(ws, false)
          pingAt.set(ws, now); ws.ping()
        }
      }
    },
    Math.min(100, config.heartbeatMs),
  )
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(config.port, config.listenHost, () => {
        server.off('error', reject)
        resolve()
      })
    })
  } catch (error) {
    clearInterval(sweep)
    auth.close()
    throw error
  }
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('Relay listener unavailable')
  return {
    port: address.port,
    // Numeric in-process ownership diagnostics; no network endpoint or payloads.
    metrics: () => ({ connections: websockets.size, reconnects, hosts: hosts.size, controllers: browsers.size, rttMs, rttSamples, bufferedBytes: [...groups].reduce((sum, group) => sum + group.retainedBytes, 0), peakBufferedBytes: Math.max(retiredPeak, 0, ...[...groups].map(group => group.peakRetainedBytes)) }),
    async close() {
      if (closing) return
      closing = true
      clearInterval(sweep)
      for (const browser of [...browsers.values()]) browser.fail('HOST_OFFLINE')
      for (const host of [...hosts.values()])
        terminateHost(host, 'HOST_OFFLINE')
      for (const ws of websockets) ws.terminate()
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await new Promise<void>((resolve) => wss.close(() => resolve()))
      leases.clear()
      routes.clear()
      auth.close()
    },
  }
}
