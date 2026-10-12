import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { DEFAULT_LIMITS, type Fence } from '@dsh-web-control/protocol'
import { hashSecret } from '../src/auth.ts'
import { startRelay } from '../src/server.ts'
import type { RelayConfig } from '../src/config.ts'
export const instanceId = '10000000-0000-0000-0000-000000000001'
export const runtimeId = '20000000-0000-0000-0000-000000000001'
export const otherId = '10000000-0000-0000-0000-000000000002'
export const enrollmentSecret = Buffer.alloc(32, 1).toString('base64url')
export const deviceSecret = Buffer.alloc(32, 2).toString('base64url')
export const linkSecret = Buffer.alloc(32, 3).toString('base64url')
export const hello = {
  v: 1,
  type: 'host.hello',
  instanceId,
  runtimeId,
  versions: [1],
  capabilities: [] as string[],
  authEpoch: 1,
  linkVerifier: hashSecret(linkSecret),
  enabled: true,
}
export class Peer {
  readonly messages: any[] = []
  readonly ws: WebSocket
  private waiters: {
    type: string
    resolve: (v: any) => void
    reject: (e: Error) => void
    timer: ReturnType<typeof setTimeout>
  }[] = []
  constructor(url: string, headers: Record<string, string> = {}) {
    this.ws = new WebSocket(url, { headers })
    this.ws.on('error', () => {})
    this.ws.on('message', (data, binary) => {
      const value = binary
        ? { type: 'binary', data }
        : JSON.parse(data.toString())
      const index = this.waiters.findIndex((w) => w.type === value.type)
      if (index < 0) this.messages.push(value)
      else {
        const w = this.waiters.splice(index, 1)[0]
        clearTimeout(w.timer)
        w.resolve(value)
      }
    })
  }
  async open(): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) return
    await new Promise<void>((resolve, reject) => {
      this.ws.once('open', resolve)
      this.ws.once('error', reject)
    })
  }
  send(message: unknown): void {
    this.ws.send(JSON.stringify(message))
  }
  next(type: string, timeout = 2000): Promise<any> {
    const index = this.messages.findIndex((m) => m.type === type)
    if (index >= 0) return Promise.resolve(this.messages.splice(index, 1)[0])
    return new Promise((resolve, reject) => {
      const w = {
        type,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter((v) => v !== w)
          reject(new Error(`Missing ${type}`))
        }, timeout),
      }
      this.waiters.push(w)
    })
  }
  async close(): Promise<void> {
    if (this.ws.readyState === WebSocket.CLOSED) return
    await new Promise<void>((resolve) => {
      this.ws.once('close', () => resolve())
      this.ws.terminate()
    })
  }
}
export async function fixture(overrides: Partial<RelayConfig> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-relay-test-'))
  await writeFile(join(dir, 'index.html'), '<html>test</html>')
  const config: RelayConfig = {
    publicOrigin: 'https://control.example.com',
    listenHost: '127.0.0.1',
    port: 0,
    databasePath: join(dir, 'auth.sqlite'),
    enrollmentVerifier: hashSecret(enrollmentSecret),
    staticDir: dir,
    heartbeatMs: 10000,
    leaseTtlMs: 30000,
    limits: { ...DEFAULT_LIMITS },
    ...overrides,
  }
  let server = await startRelay(config)
  const peers: Peer[] = []
  const http = () => `http://127.0.0.1:${server.port}`
  const socket = (path: string, headers: Record<string, string>) => {
    const p = new Peer(`ws://127.0.0.1:${server.port}${path}`, headers)
    peers.push(p)
    return p
  }
  const post = (
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ) =>
    fetch(http() + path, {
      method: 'POST',
      headers: {
        Origin: config.publicOrigin,
        'Content-Type': 'application/json',
        ...headers,
      },
      body: JSON.stringify(body),
    })
  const register = () =>
    post('/v1/devices/register', {
      enrollmentSecret,
      instanceId,
      deviceSecret,
      linkVerifier: hashSecret(linkSecret),
      authEpoch: 1,
    })
  const login = async () => {
    const response = await post(`/v1/instances/${instanceId}/login`, {
      secret: linkSecret,
    })
    if (response.status !== 200) throw new Error(`login ${response.status}`)
    return response.headers.get('set-cookie')!.split(';')[0]
  }
  const host = async (value = hello) => {
    const p = socket('/v1/host', {
      Authorization: `Bearer ${deviceSecret}`,
      'X-DSH-Instance': instanceId,
    })
    await p.open()
    p.send(value)
    return p
  }
  const browser = async (
    cookie: string,
    resume?: { id: string; secret: string },
  ) => {
    const p = socket(`/v1/instances/${instanceId}/control`, {
      Cookie: cookie,
      Origin: config.publicOrigin,
    })
    await p.open()
    p.send({
      v: 1,
      type: 'browser.hello',
      versions: [1],
      ...(resume ? { resume } : {}),
    })
    return p
  }
  const attach = async (h: Peer, cookie: string) => {
    const b = await browser(cookie)
    const lease = await b.next('browser.lease')
    b.send({ v: 1, type: 'browser.lease-ack', id: lease.id })
    const request = await h.next('attach')
    h.send({
      v: 1,
      type: 'host.attached',
      id: request.id,
      fence: request.fence,
    })
    await b.next('ready')
    return { b, fence: request.fence as Fence, lease }
  }
  return {
    config,
    post,
    register,
    login,
    host,
    browser,
    attach,
    socket,
    http,
    async restart() {
      await server.close()
      server = await startRelay(config)
    },
    async close() {
      await Promise.all(peers.map((p) => p.close()))
      await server.close()
      await rm(dir, { recursive: true, force: true })
    },
  }
}
export const delay = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms))
