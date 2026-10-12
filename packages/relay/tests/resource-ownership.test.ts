import { expect, test } from 'vitest'
import { createServer } from 'node:http'
import WebSocket, { WebSocketServer } from 'ws'
import { DEFAULT_LIMITS } from '../../protocol/src/index.ts'
import { TransportGroup } from '../src/transport.ts'

test('real socket delayed completion keeps currently sending frame inside relay aggregate budget', async () => {
  const server = createServer(), wss = new WebSocketServer({ server })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const accepted = new Promise<WebSocket>(resolve => wss.once('connection', resolve))
  const client = new WebSocket(`ws://127.0.0.1:${(server.address() as { port: number }).port}`)
  await new Promise<void>(resolve => client.once('open', resolve)); const socket = await accepted
  let completed: (() => void) | undefined
  const realSend = socket.send.bind(socket)
  socket.send = ((data: Uint8Array, options: object, callback: (error?: Error) => void) => {
    realSend(data, options, error => { completed = () => callback(error) })
  }) as typeof socket.send
  const failures: string[] = [], group = new TransportGroup({ ...DEFAULT_LIMITS, bufferedBytes: 1700 }, code => failures.push(code))
  const transport = group.add(socket)
  try {
    const received = new Promise<void>(resolve => client.once('message', () => resolve()))
    group.enqueue((transport as unknown as { id: number }).id, new Uint8Array(800), true)
    await received
    // Exact real callback is withheld. Its current 816-byte frame is still owned.
    expect(group.bufferedBytes).toBeGreaterThanOrEqual(816)
    expect(() => group.enqueue((transport as unknown as { id: number }).id, new Uint8Array(1000), true)).toThrow('RESYNC_REQUIRED')
    expect(failures).toEqual(['RESYNC_REQUIRED'])
    completed!(); completed = undefined
  } finally {
    completed?.(); group.dispose()
    await Promise.all([client, socket].map(peer => new Promise<void>(resolve => { if (peer.readyState === WebSocket.CLOSED) resolve(); else { peer.once('close', resolve); peer.terminate() } })))
    await new Promise<void>(resolve => wss.close(() => resolve())); await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
