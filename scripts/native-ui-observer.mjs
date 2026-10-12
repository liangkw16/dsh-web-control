/** Test-only observer injected before the untouched stock shell. Records structure, never RPC values. */
export function installNativeUiObserver(options = {}) {
  const observations = [], keys = new Set();
  const denied = [];
  function shape(value, depth = 0) {
    if (value === null) return 'null';
    if (Array.isArray(value)) return { array: value.length ? shape(value[0], depth + 1) : 'empty' };
    if (typeof value !== 'object' || depth >= 5) return typeof value;
    return Object.fromEntries(Object.keys(value).sort().slice(0, 80).map(key => [key, shape(value[key], depth + 1)]));
  }
  function record(kind, channel, endpoint, payload) {
    const item = { kind, channel, endpoint, shape: shape(payload) }, key = JSON.stringify(item);
    if (!keys.has(key) && observations.length < 1000) { keys.add(key); observations.push(item); }
  }
  globalThis.__nativeUiInventory = { observations, denied };
  globalThis.__DSH_TRANSPORT__ = { rpc: {
    async call(channel, endpoint, payload, signal) {
      record('call', channel, endpoint, payload);
      if (options.denyQueueWrites && channel === '/api' && endpoint === 'session/updateQueue') {
        denied.push({ channel, endpoint });
        throw new Error('Queue editing is unavailable in this fixture');
      }
      const rpcId = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
      const response = await fetch(`${channel}/${endpoint}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload }), signal });
      if (!response.ok) throw new Error(`Fixture HTTP ${response.status}: ${endpoint}`);
      const envelope = await response.json();
      if (envelope.rpcId !== rpcId) throw new Error('Fixture correlation mismatch');
      record('result', channel, endpoint, envelope.result);
      return envelope.result;
    },
    async *open(channel, endpoint, payload, signal, uplink) {
      if (channel !== '/api') throw new Error('Unsupported fixture stream channel');
      record('open', channel, endpoint, payload);
      const url = new URL('/api/remote.mux', location.href); url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(url), streamId = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
      let closed = false, failure, wake = () => {}, queue = [];
      const abort = () => { closed = true; wake(); if (socket.readyState === 1) socket.close(); };
      const onMessage = event => {
        const frame = JSON.parse(event.data);
        if (frame.streamId !== streamId) return;
        if (frame.type === 'item') { record('item', channel, endpoint, frame.value); queue.push(frame.value); }
        else { closed = true; if (frame.type === 'error') failure = new Error(frame.error.code); }
        wake();
      };
      socket.addEventListener('message', onMessage);
      socket.addEventListener('close', () => { closed = true; wake(); });
      socket.addEventListener('error', () => { failure = new Error('Fixture stream carrier closed'); closed = true; wake(); });
      signal?.addEventListener('abort', abort, { once: true });
      let producer;
      try {
        await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
        if (signal?.aborted || closed) { abort(); return; }
        socket.send(JSON.stringify({ type: 'open', streamId, endpoint, payload }));
        if (uplink) producer = (async () => {
          for await (const value of uplink) { if (closed) break; socket.send(JSON.stringify({ type: 'item', streamId, value })); }
          if (!closed) socket.send(JSON.stringify({ type: 'end', streamId }));
        })().catch(error => { failure = error; closed = true; wake(); });
        while (!closed || queue.length) {
          if (queue.length) yield queue.shift();
          else await new Promise(resolve => { wake = resolve; });
        }
        if (failure) throw failure;
      } finally {
        closed = true; signal?.removeEventListener('abort', abort);
        if (socket.readyState === 1) { socket.send(JSON.stringify({ type: 'cancel', streamId })); socket.close(); }
        else if (socket.readyState === 0) socket.addEventListener('open', () => socket.close(), { once: true });
        await producer;
      }
    },
  } };
}
