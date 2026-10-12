/** Task-owned real HTTP/WebSocket relay. No product fault endpoints. */
import { mkdtemp, rm, writeFile, copyFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, request } from 'node:http'
import type { Socket } from 'node:net'
import { createRequire } from 'node:module'
import type { WebSocket as SocketType } from 'ws'
const require = createRequire(new URL('../../packages/relay/package.json', import.meta.url))
const WebSocket = require('ws') as typeof import('ws').default
const WebSocketServer = require('ws').WebSocketServer as typeof import('ws').WebSocketServer
import { DEFAULT_LIMITS, type Limits } from '../../packages/protocol/src/index.ts'
import { startRelay } from '../../packages/relay/src/server.ts'
import { hashSecret } from '../../packages/relay/src/auth.ts'
import { enrollmentSecret } from '../../packages/relay/tests/socket-fixture.ts'

/** Public socket proxy controls only task-owned transport and records numeric metadata. */
export class RelayDriver {
  dir = ''
  readonly publicOrigin = 'https://control.example.com'
  private relay?: Awaited<ReturnType<typeof startRelay>>
  private proxy?: ReturnType<typeof createServer>
  private wss = new WebSocketServer({ noServer: true })
  private peers = new Set<SocketType>()
  private tcp = new Set<Socket>()
  private pending = new Set<ReturnType<typeof setTimeout>>()
  private ackDrop = false
  private dataDelay = 0
  private rate = 0
  private nextDataAt = 0
  private readonly ordered = new WeakMap<SocketType, { at: number; send(): void }[]>()
  private readonly activity = new Map<SocketType, { watches: Set<string>; transfers: Set<string> }>()
  private buffered = 0
  peakBuffered = 0
  readonly faults: string[] = []
  readonly binaryHash = createHash('sha256')
  shapedBytes = 0
  independentTimersForRegression = false
  endTimerAdvanceMsForRegression = 0
  readonly sends: { type: string; at: number; bytes: number; route: string; index?: number }[] = []
  port = 0
  constructor(readonly limits: Limits = { ...DEFAULT_LIMITS }) {}
  get origin(): string { return `http://127.0.0.1:${this.port}` }
  async start(): Promise<void> {
    this.dir = await mkdtemp(join(tmpdir(), 'dsh-system-task13-'))
    await writeFile(join(this.dir, 'index.html'), '<html>isolated fixture</html>')
    await this.startBackend()
    this.proxy = createServer((incoming, response) => {
      const forward = request(`http://127.0.0.1:${this.relay!.port}${incoming.url}`, { method: incoming.method, headers: incoming.headers }, upstream => {
        response.writeHead(upstream.statusCode!, upstream.headers); upstream.pipe(response)
      })
      forward.on('error', () => { response.writeHead(503); response.end() }); incoming.pipe(forward)
    })
    this.proxy.on('connection', socket => { this.tcp.add(socket); socket.once('close', () => this.tcp.delete(socket)) })
    this.proxy.on('upgrade', (incoming, socket, head) => {
      this.wss.handleUpgrade(incoming, socket, head, downstream => {
        const upstream = new WebSocket(`ws://127.0.0.1:${this.relay!.port}${incoming.url}`, { headers: incoming.headers })
        this.peers.add(downstream); this.peers.add(upstream)
        const activity = { watches: new Set<string>(), transfers: new Set<string>() }
        this.activity.set(downstream, activity); this.activity.set(upstream, activity)
        const early: { bytes: Buffer; binary: boolean }[] = []
        upstream.on('open', () => { for (const frame of early.splice(0)) upstream.send(frame.bytes, { binary: frame.binary }) })
        const close = () => { downstream.terminate(); upstream.terminate() }
        upstream.on('error', close); downstream.on('error', close)
        for (const peer of [downstream, upstream]) peer.once('close', () => { this.peers.delete(peer); this.activity.delete(downstream); this.activity.delete(upstream); close() })
        downstream.on('message', (raw, binary) => {
          const bytes = Buffer.from(raw as Buffer)
          if (upstream.readyState === WebSocket.CONNECTING) early.push({ bytes, binary })
          else this.forward(upstream, bytes, binary, incoming.url !== '/v1/host', incoming.url === '/v1/host' ? 'host-to-relay' : 'browser-to-relay')
        })
        upstream.on('message', (raw, binary) => {
          const bytes = Buffer.from(raw as Buffer)
          if (!binary && this.ackDrop && JSON.parse(bytes.toString()).type === 'relay.ack') { this.ackDrop = false; return }
          this.forward(downstream, bytes, binary, false, incoming.url === '/v1/host' ? 'relay-to-host' : 'relay-to-browser')
        })
      })
    })
    await new Promise<void>(resolve => this.proxy!.listen(0, '127.0.0.1', resolve))
    this.port = (this.proxy.address() as { port: number }).port
  }
  private async startBackend(): Promise<void> {
    this.relay = await startRelay({ publicOrigin: this.publicOrigin, listenHost: '127.0.0.1', port: 0,
      databasePath: join(this.dir, 'auth.sqlite'), enrollmentVerifier: hashSecret(enrollmentSecret), staticDir: this.dir,
      heartbeatMs: 10000, leaseTtlMs: 30000, limits: this.limits })
  }
  private forward(socket: SocketType, bytes: Buffer, binary: boolean, throttled = false, route = 'unknown'): void {
    const parsed = binary ? undefined : JSON.parse(bytes.toString())
    const type = binary ? 'binary' : String(parsed.type)
    if (type === 'fault') this.faults.push(String(parsed.error.code))
    const activity = this.activity.get(socket)
    if (throttled && type === 'watch') activity?.watches.add(parsed.id)
    if (type === 'end' || type === 'cancel') activity?.watches.delete(parsed.id)
    if (throttled && type === 'upload.open') activity?.transfers.add(parsed.id)
    if (type === 'result' || type === 'cancel') activity?.transfers.delete(parsed.id)
    const delayed = binary || type === 'event' || type === 'upload.end'
    let delay = delayed ? this.dataDelay : 0
    if (binary && throttled && this.rate) { this.shapedBytes += bytes.length; this.binaryHash.update(bytes); const now = performance.now(); this.nextDataAt = Math.max(now, this.nextDataAt) + bytes.length * 8000 / this.rate; delay += this.nextDataAt - now }
    if (type === 'upload.end' && throttled && this.rate) delay += Math.max(0, this.nextDataAt - performance.now())
    const send = () => { this.buffered -= bytes.length; if (socket.readyState === WebSocket.OPEN) { this.sends.push({ type, at: performance.now(), bytes: bytes.length, route, ...(binary ? { index: bytes.readUInt32BE(36) } : {}) }); socket.send(bytes, { binary }) } }
    this.buffered += bytes.length; this.peakBuffered = Math.max(this.peakBuffered, this.buffered)
    // Data/end preserve wire order per destination even when timer rounding
    // would let an independently scheduled end beat the last shaped chunk.
    if (delayed && this.independentTimersForRegression) {
      const timer = setTimeout(() => { this.pending.delete(timer); send() }, Math.max(0, delay - (type === 'upload.end' ? this.endTimerAdvanceMsForRegression : 0))); this.pending.add(timer)
    } else if (delayed) {
      const queue = this.ordered.get(socket) ?? []
      this.ordered.set(socket, queue); queue.push({ at: performance.now() + delay, send })
      if (queue.length === 1) this.drainOrdered(queue)
    } else send()
  }
  private drainOrdered(queue: { at: number; send(): void }[]): void {
    const timer = setTimeout(() => {
      this.pending.delete(timer); queue.shift()!.send()
      if (queue.length) this.drainOrdered(queue)
    }, Math.max(0, queue[0].at - performance.now()))
    this.pending.add(timer)
  }
  dropNextAck(): void { this.ackDrop = true }
  delayData(ms: number): void { this.dataDelay = ms }
  rateLimit(bitsPerSecond: number): void { this.rate = bitsPerSecond; this.nextDataAt = 0 }
  metrics(): { bufferedBytes: number; activeStreams: number; activeTransfers: number } {
    const activity = [...new Set(this.activity.values())]
    return { bufferedBytes: this.relay?.metrics().bufferedBytes ?? 0, activeStreams: activity.reduce((n, a) => n + a.watches.size, 0), activeTransfers: activity.reduce((n, a) => n + a.transfers.size, 0) }
  }
  proxyBufferedBytes(): number { return this.buffered + [...this.peers].reduce((sum, peer) => sum + peer.bufferedAmount, 0) }
  peakRelayBytes(): number { return this.relay?.metrics().peakBufferedBytes ?? 0 }
  async backup(): Promise<string> {
    // Closed DB copy only: avoids partial WAL snapshots. Caller has disconnected Host.
    await this.relay!.close(); this.relay = undefined
    const path = join(this.dir, 'old-auth.sqlite'); await copyFile(join(this.dir, 'auth.sqlite'), path); await this.startBackend(); return path
  }
  async restart(backup?: string): Promise<void> {
    await this.relay?.close(); this.relay = undefined
    if (backup) await copyFile(backup, join(this.dir, 'auth.sqlite'))
    await this.startBackend()
  }
  async close(): Promise<void> {
    for (const timer of this.pending) clearTimeout(timer); this.pending.clear(); this.buffered = 0; this.activity.clear()
    const closing = [...this.peers].map(peer => new Promise<void>(resolve => { if (peer.readyState === WebSocket.CLOSED) resolve(); else { peer.once('close', resolve); peer.terminate() } }))
    await Promise.all(closing); await this.relay?.close(); this.relay = undefined
    for (const socket of this.tcp) socket.destroy()
    if (this.proxy) await new Promise<void>(resolve => this.proxy!.close(() => resolve()))
    await new Promise<void>(resolve => this.wss.close(() => resolve()))
    if (this.dir) await rm(this.dir, { recursive: true, force: true })
  }
}
