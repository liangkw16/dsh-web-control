import { createServer, get } from 'node:http'
/** A live process with invalid configuration exposes no application routes. */
export async function unavailableHealth(port: number, host: string) {
  const server = createServer((req, res) => {
    const live = req.method === 'GET' && req.url === '/health/live'
    const ready = req.method === 'GET' && req.url === '/health/ready'
    res.writeHead(live ? 200 : ready ? 503 : 404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify({ ok: live, ...ready ? { code: 'CONFIG_UNAVAILABLE' } : {} }))
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Health listener unavailable')
  return { port: address.port, close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) } }
}
export function probeHealth(port = 8787): Promise<void> {
  return Promise.all(['/health/live', '/health/ready'].map(path => new Promise<void>((resolve, reject) => {
    const req = get({ host: '127.0.0.1', port, path, timeout: 2000 }, res => { res.resume(); res.statusCode === 200 ? resolve() : reject(new Error('Health unavailable')) })
    req.on('timeout', () => req.destroy(new Error('Health timeout'))); req.on('error', reject)
  }))).then(() => {})
}
