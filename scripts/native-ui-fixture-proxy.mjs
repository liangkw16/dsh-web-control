/** Owned loopback proxy with a non-loopback browser hostname, for stock UI authority checks. */
import { createServer } from 'node:https';
import { WebSocket, WebSocketServer } from '../packages/relay/node_modules/ws/wrapper.mjs';
export function fixtureTarget(target, upstream) {
  if (typeof target !== 'string' || !target.startsWith('/') || target.startsWith('//') || /[\\\x00-\x20]/.test(target)) throw new Error('Invalid fixture request target');
  const url = new URL(target, upstream);
  if (url.origin !== new URL(upstream).origin) throw new Error('Cross-origin fixture request');
  return url;
}
export async function startFixtureProxy({ upstream, cookie, key, cert }) {
  const sockets = new Set(), bridges = new Set(), requests = [], inflight = new Set();
  const server = createServer({ key, cert }, async (request, response) => {
    let target;
    try { target = fixtureTarget(request.url, upstream); } catch { response.writeHead(400); response.end(); return; }
    const abort = new AbortController(); inflight.add(abort);
    response.once('close', () => abort.abort());
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const reply = await fetch(target, { method: request.method, headers: { cookie, origin: upstream, ...(request.headers['content-type'] ? { 'content-type': request.headers['content-type'] } : {}) }, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}), redirect: 'manual', signal: abort.signal });
      requests.push({ path: target.pathname, status: reply.status });
      const bytes = Buffer.from(await reply.arrayBuffer());
      if (response.destroyed) return;
      response.writeHead(reply.status, { 'content-type': reply.headers.get('content-type') ?? 'application/octet-stream', 'cache-control': 'no-store' }); response.end(bytes);
    } catch (error) { requests.push({ path: target.pathname, error: error.name }); if (!response.destroyed) { if (!response.headersSent) response.writeHead(502); response.end(); } }
    finally { inflight.delete(abort); }
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => {
    if (request.url !== '/api/remote.mux') { socket.destroy(); return; }
    wss.handleUpgrade(request, socket, head, incoming => {
      const outgoing = new WebSocket(upstream.replace('http:', 'ws:') + request.url, { headers: { cookie, origin: upstream } });
      bridges.add(incoming); bridges.add(outgoing);
      const pending = [];
      incoming.on('message', (bytes, binary) => { if (outgoing.readyState === WebSocket.OPEN) outgoing.send(bytes, { binary }); else pending.push([bytes, binary]); });
      outgoing.on('open', () => { for (const [bytes, binary] of pending) outgoing.send(bytes, { binary }); pending.length = 0; });
      outgoing.on('message', (bytes, binary) => { if (incoming.readyState === WebSocket.OPEN) incoming.send(bytes, { binary }); });
      for (const [a, b] of [[incoming, outgoing], [outgoing, incoming]]) {
        a.on('error', () => { a.terminate(); b.terminate(); }); a.on('close', () => { bridges.delete(a); b.terminate(); });
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { requests, origin: `https://native-ui.test:${server.address().port}`, async close() {
    for (const abort of inflight) abort.abort();
    const ended = [...bridges].map(socket => new Promise(resolve => socket.once('close', resolve)));
    for (const socket of bridges) socket.terminate(); await Promise.all(ended);
    await new Promise(resolve => wss.close(resolve));
    const closed = new Promise(resolve => server.close(resolve)); for (const socket of sockets) socket.destroy(); await closed;
    return { sockets: sockets.size, bridges: bridges.size };
  } };
}
