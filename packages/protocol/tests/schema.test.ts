import { describe, expect, test } from 'vitest';
import { DEFAULT_LIMITS, parseController, parseHost, parseHandshake, validateFence, negotiate, encodeChunk, decodeChunk, validateLimits, validateHeartbeat, ProtocolError, TransferReceiver, TransferWindow } from '../src/index.ts';
const id = '00000000-0000-4000-8000-000000000001';
const runtimeId = '00000000-0000-4000-8000-000000000002';
const controlId = '00000000-0000-4000-8000-000000000003';
const fence = { instanceId: id, runtimeId, controlId, authEpoch: 1 };
const call = { v: 1, type: 'call', id, fence, command: { op: 'session.list', workspaceId: 'workspace' } };
const parse = (value: unknown) => parseController(JSON.stringify(value), DEFAULT_LIMITS);
test('strict controller schema rejects malformed JSON, unknown operations/fields and non-v1', () => {
  expect(() => parseController('{', DEFAULT_LIMITS)).toThrow('INVALID_MESSAGE');
  expect(parse(call)).toEqual(call);
  for (const value of [{ ...call, secret: 'x' }, { ...call, v: 2 }, { ...call, command: { op: 'exec' } }, { ...call, fence: { ...fence, localhostToken: 'x' } }, { ...call, id: 'host-a' }]) expect(() => parse(value)).toThrow();
});
test('numeric and JSON boundaries are checked before parsing', () => {
  for (const authEpoch of [0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) expect(() => parse({ ...call, fence: { ...fence, authEpoch } })).toThrow('INVALID_MESSAGE');
  expect(parse({ ...call, fence: { ...fence, authEpoch: 1 } })).toBeDefined();
  expect(() => parseController('x'.repeat(11), { ...DEFAULT_LIMITS, jsonBytes: 10 })).toThrow('LIMIT_EXCEEDED');
  expect(() => parseController('"ééé"', { ...DEFAULT_LIMITS, jsonBytes: 7 })).toThrow('LIMIT_EXCEEDED');
  for (const answer of ['{"__proto__":{}}', '{"x":1e400}', '{"localhostToken":"x"}', '{"constructor":{}}']) expect(() => parseController(`{"v":1,"type":"call","id":"${id}","fence":${JSON.stringify(fence)},"command":{"op":"interaction.answer","deliveryId":"delivery","answer":${answer}}}`, DEFAULT_LIMITS)).toThrow('INVALID_MESSAGE');
});
test('every command and watch shape has strict bounded numeric fields', () => {
  const commands = [
    { op: 'session.create', workspaceId: 'w', sessionId: 's' },
    { op: 'session.prompt', sessionId: 's', requestId: id, mode: 'queue', content: [{ kind: 'text', text: '' }, { kind: 'upload', receiptId: 'r', name: 'n', mediaType: 'text/plain' }], clientTimeZone: 'Asia/Shanghai' },
    { op: 'session.page', sessionId: 's', throughSeq: 0, beforeSeq: 0, maxMessages: 1 },
    { op: 'session.stop', sessionId: 's', stopToken: 'stop' },
    { op: 'interaction.answer', deliveryId: 'd', answer: { data: [null, true, 1] } },
    { op: 'file.read', sessionId: 's', path: 'a', offset: 0, length: 1048576 },
    { op: 'file.changes', sessionId: 's', seq: 0 }, { op: 'file.diff', sessionId: 's', seq: 0, index: 0 },
  ];
  for (const command of commands) { expect(parse({ ...call, command })).toBeDefined(); expect(() => parse({ ...call, command: { ...command, extra: 1 } })).toThrow(); }
  for (const watch of [{ topic: 'workspaces' }, { topic: 'sessions' }, { topic: 'interactions' }, { topic: 'session', sessionId: 's', maxMessages: 1 }]) expect(parse({ v: 1, type: 'watch', id, fence, watch })).toBeDefined();
  for (const length of [-1, 1048577, 0.5]) expect(() => parse({ ...call, command: { op: 'file.read', sessionId: 's', path: 'x', offset: 0, length } })).toThrow();
});
test('upload/download envelopes are bidirectional and bounded', () => {
  expect(parse({ v: 1, type: 'upload.open', id, fence, sessionId: 's', name: 'n', mediaType: 'x', bytes: DEFAULT_LIMITS.fileBytes })).toBeDefined();
  expect(() => parse({ v: 1, type: 'upload.open', id, fence, sessionId: 's', name: 'n', mediaType: 'x', bytes: DEFAULT_LIMITS.fileBytes + 1 })).toThrow();
  for (const chunks of [1, 4]) expect(parse({ v: 1, type: 'download.credit', id, fence, chunks })).toBeDefined();
  for (const chunks of [0, 5]) expect(() => parse({ v: 1, type: 'download.credit', id, fence, chunks })).toThrow();
  for (const type of ['result', 'event', 'end', 'upload.credit', 'download.end']) {
    const fields = type === 'result' ? { result: { ok: true, value: null } } : type === 'event' ? { value: [] } : type.endsWith('credit') ? { chunks: 4 } : type === 'download.end' ? { chunks: 0 } : {};
    expect(parseHost(JSON.stringify({ v: 1, type, id, fence, ...fields }), DEFAULT_LIMITS)).toBeDefined();
  }
  expect(parse({ v: 1, type: 'cancel', id, fence })).toBeDefined();
  expect(parse({ v: 1, type: 'heartbeat', fence })).toBeDefined();
});
test('handshakes are separate, strict and do not carry credentials', () => {
  const hello = { v: 1, type: 'host.hello', instanceId: id, runtimeId, versions: [1], capabilities: ['files'], authEpoch: 1, linkVerifier: 'a'.repeat(64), enabled: true };
  expect(parseHandshake(JSON.stringify(hello), DEFAULT_LIMITS)).toEqual(hello);
  for (const credential of ['token', 'localhostToken', 'deviceSecret', 'sessionToken']) expect(() => parseHandshake(JSON.stringify({ ...hello, [credential]: 'secret' }), DEFAULT_LIMITS)).toThrow();
  for (const value of [{ v: 1, type: 'relay.ack', version: 1, authEpoch: 1, enabled: true, linkVerifier: 'a'.repeat(64) }, { v: 1, type: 'attach', id, leaseId: id, fence }, { v: 1, type: 'host.attached', id, fence }, { v: 1, type: 'ready', fence }]) expect(parseHandshake(JSON.stringify(value), DEFAULT_LIMITS)).toBeDefined();
  expect(() => parse(hello)).toThrow();
});
test('authorization epochs are positive safe integers in every Fence and authorization handshake', () => {
  const hello = { v: 1, type: 'host.hello', instanceId: id, runtimeId, versions: [1], capabilities: [], linkVerifier: 'a'.repeat(64), enabled: true };
  const ack = { v: 1, type: 'relay.ack', version: 1, linkVerifier: 'a'.repeat(64), enabled: true };
  for (const authEpoch of [1, Number.MAX_SAFE_INTEGER]) {
    expect(validateFence({ ...fence, authEpoch }).authEpoch).toBe(authEpoch);
    for (const message of [hello, ack]) expect(parseHandshake(JSON.stringify({ ...message, authEpoch }), DEFAULT_LIMITS)).toBeDefined();
  }
  for (const authEpoch of [0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity]) {
    const invalidFence = { ...fence, authEpoch };
    expect(() => validateFence(invalidFence)).toThrow('INVALID_MESSAGE');
    expect(() => parse({ ...call, fence: invalidFence })).toThrow('INVALID_MESSAGE');
    expect(() => parseHost(JSON.stringify({ v: 1, type: 'end', id, fence: invalidFence }), DEFAULT_LIMITS)).toThrow('INVALID_MESSAGE');
    for (const message of [hello, ack]) expect(() => parseHandshake(JSON.stringify({ ...message, authEpoch }), DEFAULT_LIMITS)).toThrow('INVALID_MESSAGE');
    for (const message of [{ type: 'attach', id, leaseId: id }, { type: 'host.attached', id }, { type: 'ready' }]) {
      expect(() => parseHandshake(JSON.stringify({ v: 1, ...message, fence: invalidFence }), DEFAULT_LIMITS)).toThrow('INVALID_MESSAGE');
    }
  }
});
test('no overlapping protocol is explicit and highest common supported version wins', () => {
  expect(() => negotiate([2], [1])).toThrow('PROTOCOL_UNSUPPORTED');
  expect(negotiate([1, 2], [2, 1])).toBe(2);
  for (const versions of [[NaN], [-1], [1.2], [Infinity]]) expect(() => negotiate(versions, [1])).toThrow();
});
test('limits reject unsafe inputs and heartbeat must allow a missed interval', () => {
  expect(validateLimits(DEFAULT_LIMITS)).toEqual(DEFAULT_LIMITS);
  for (const key of Object.keys(DEFAULT_LIMITS)) for (const value of [-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1, 0]) expect(() => validateLimits({ ...DEFAULT_LIMITS, [key]: value })).toThrow();
  expect(validateHeartbeat(10000, 30000)).toBeUndefined();
  expect(() => validateHeartbeat(10000, 10000)).toThrow();
});
test('binary header round trips and rejects forged payload lengths/indices', () => {
  const encoded = encodeChunk(id, controlId, 0, new Uint8Array([1, 2, 3]));
  expect(decodeChunk(encoded, DEFAULT_LIMITS)).toEqual({ id, controlId, index: 0, data: new Uint8Array([1, 2, 3]) });
  expect(() => decodeChunk(encoded.subarray(0, encoded.length - 1), DEFAULT_LIMITS)).toThrow();
  const forged = encoded.slice(); new DataView(forged.buffer).setUint32(40, 1000000);
  expect(() => decodeChunk(forged, DEFAULT_LIMITS)).toThrow();
  expect(() => encodeChunk(id, controlId, -1, new Uint8Array([1]))).toThrow();
  expect(() => decodeChunk(encoded, { ...DEFAULT_LIMITS, chunkBytes: 2 })).toThrow('LIMIT_EXCEEDED');
});
test('oversize JSON is a terminal bound error, not resync', () => {
  expect.assertions(4);
  try {
    parseHost('x'.repeat(11), { ...DEFAULT_LIMITS, jsonBytes: 10 });
  } catch (error) {
    expect(error).toBeInstanceOf(ProtocolError);
    expect((error as ProtocolError).code).toBe('LIMIT_EXCEEDED');
    expect((error as ProtocolError).message).toContain('10');
    expect((error as ProtocolError).retryable).toBe(false);
  }
});
describe('bounded transfer resources', () => {
  test('receiver checks credit, order, exact open/end count and releases queued data', async () => {
    const receiver = new TransferReceiver(id, controlId, 3, DEFAULT_LIMITS);
    receiver.grant(1); receiver.receive(encodeChunk(id, controlId, 0, new Uint8Array([1, 2, 3]))); receiver.end(1);
    expect(await receiver.next()).toEqual({ done: false, value: new Uint8Array([1, 2, 3]) });
    expect((await receiver.next()).done).toBe(true); expect(receiver.bufferedBytes).toBe(0);
    const invalid = new TransferReceiver(id, controlId, 3, DEFAULT_LIMITS); invalid.grant(1);
    expect(() => invalid.receive(encodeChunk(id, controlId, 1, new Uint8Array([1])))).toThrow(); expect(invalid.bufferedBytes).toBe(0);
    const noCredit = new TransferReceiver(id, controlId, 3, DEFAULT_LIMITS); expect(() => noCredit.receive(encodeChunk(id, controlId, 0, new Uint8Array([1])))).toThrow('BACKPRESSURE');
    const short = new TransferReceiver(id, controlId, 3, DEFAULT_LIMITS); expect(() => short.end(0)).toThrow();
  });
  test('queued frames and granted credits together never exceed four, even empty frames', () => {
    const receiver = new TransferReceiver(id, controlId, 8, DEFAULT_LIMITS); receiver.grant(4);
    receiver.receive(encodeChunk(id, controlId, 0, new Uint8Array([1])));
    expect(() => receiver.grant(1)).toThrow('BACKPRESSURE'); receiver.dispose();
    expect(() => encodeChunk(id, controlId, 0, new Uint8Array())).toThrow();
  });
  test('abort, iterator return, and idle timeout finish pending reads', async () => {
    const abort = new AbortController(); const receiver = new TransferReceiver(id, controlId, 1, DEFAULT_LIMITS, abort.signal);
    const pending = receiver.next(); abort.abort(); await expect(pending).rejects.toThrow('TRANSFER_CLOSED');
    const returned = new TransferReceiver(id, controlId, 1, DEFAULT_LIMITS); const read = returned.next(); await returned.return(); expect((await read).done).toBe(true);
    const timeout = new TransferReceiver(id, controlId, 1, { ...DEFAULT_LIMITS, transferIdleMs: 5 }); await expect(timeout.next()).rejects.toThrow('TRANSFER_TIMEOUT');
  });
  test('sender grants cumulative credit only to a four-chunk window and validates final bytes', () => {
    const window = new TransferWindow(3, DEFAULT_LIMITS); window.grant(1); expect(window.consume(3)).toBe(0); expect(window.finish()).toBe(1);
    expect(() => window.consume(1)).toThrow();
    const limited = new TransferWindow(3, DEFAULT_LIMITS); limited.grant(4); expect(() => limited.grant(1)).toThrow('BACKPRESSURE');
    expect(() => new TransferWindow(3, DEFAULT_LIMITS).finish()).toThrow();
  });
});

test('download metadata is a distinct validated result payload and bounded range', async () => {
  const { validateDownloadMetadata } = await import('../src/index.ts');
  const metadata = { transferId: id, name: 'n', mediaType: 'text/plain', bytes: 1048576, offset: 0, eof: false };
  expect(validateDownloadMetadata(metadata, DEFAULT_LIMITS)).toEqual(metadata);
  for (const value of [{ ...metadata, bytes: 1048577 }, { ...metadata, offset: Number.MAX_SAFE_INTEGER }, { ...metadata, transferId: 'host-a' }, { ...metadata, extra: true }]) expect(() => validateDownloadMetadata(value, DEFAULT_LIMITS)).toThrow();
  expect(() => parseHost(JSON.stringify({ v: 1, type: 'download.open', id, fence, metadata }), DEFAULT_LIMITS)).toThrow();
  expect(parseHost(JSON.stringify({ v: 1, type: 'result', id: runtimeId, fence, result: { ok: true, value: metadata } }), DEFAULT_LIMITS)).toBeDefined();
});
test('finite plain JSON rejects functions, inherited prototypes and unsafe property descriptors', async () => {
  const { validateJson } = await import('../src/index.ts');
  for (const value of [NaN, Infinity, undefined, () => {}, Object.create({ inherited: 1 }), { constructor: 1 }, Object.defineProperty({}, 'hidden', { value: () => {} }), { get value() { return 'secret'; } }, Object.assign([], { extra: () => {} })]) expect(() => validateJson(value)).toThrow();
  expect(validateJson({ value: [null, false, 2, 'x'] })).toEqual({ value: [null, false, 2, 'x'] });
});
test('limits take smaller Host ceilings and preserve validated immutable transfer config', async () => {
  const { effectiveLimits } = await import('../src/index.ts');
  expect(effectiveLimits(DEFAULT_LIMITS, { chunkBytes: 1, calls: 2 }).chunkBytes).toBe(1);
  expect(effectiveLimits(DEFAULT_LIMITS, { chunkBytes: DEFAULT_LIMITS.chunkBytes + 1 }).chunkBytes).toBe(DEFAULT_LIMITS.chunkBytes);
  expect(() => effectiveLimits(DEFAULT_LIMITS, { chunkBytes: NaN })).toThrow();
  const limits = { ...DEFAULT_LIMITS, chunkBytes: 1 };
  const receiver = new TransferReceiver(id, controlId, 2, limits); receiver.grant(1); limits.chunkBytes = 2;
  expect(() => receiver.receive(encodeChunk(id, controlId, 0, new Uint8Array([1, 2])))).toThrow('LIMIT_EXCEEDED');
});
test.each(['call', 'watch', 'cancel', 'upload.open', 'upload.end', 'download.credit', 'heartbeat'])('controller %s rejects unregistered fields', type => {
  const variants: Record<string, object> = { call, watch: { v: 1, type, id, fence, watch: { topic: 'sessions' } }, cancel: { v: 1, type, id, fence }, 'upload.open': { v: 1, type, id, fence, sessionId: 's', name: 'n', mediaType: 'x', bytes: 0 }, 'upload.end': { v: 1, type, id, fence, chunks: 0 }, 'download.credit': { v: 1, type, id, fence, chunks: 1 }, heartbeat: { v: 1, type, fence } };
  expect(() => parse({ ...variants[type], extra: true })).toThrow();
});
test.each(['result', 'event', 'end', 'upload.credit', 'download.end'])('Host %s rejects unknown fields and invalid numbers', type => {
  const fields = type === 'result' ? { result: { ok: false, error: { code: 'REMOTE_BUSY', message: 'busy', retryable: true } } } : type === 'event' ? { value: null } : type === 'upload.credit' ? { chunks: 1 } : type === 'download.end' ? { chunks: 0 } : {};
  const message = { v: 1, type, id, fence, ...fields };
  expect(parseHost(JSON.stringify(message), DEFAULT_LIMITS)).toEqual(message);
  expect(() => parseHost(JSON.stringify({ ...message, extra: 1 }), DEFAULT_LIMITS)).toThrow();
  expect(() => parseHost(JSON.stringify({ ...message, fence: { ...fence, authEpoch: -1 } }), DEFAULT_LIMITS)).toThrow();
});
test('binary decoders reject wrong magic, too-short header and forged lengths without copying', () => {
  for (const length of [0, 43]) expect(() => decodeChunk(new Uint8Array(length), DEFAULT_LIMITS)).toThrow();
  const input = encodeChunk(id, controlId, 0xffffffff, new Uint8Array([7]));
  expect(decodeChunk(input, DEFAULT_LIMITS).index).toBe(0xffffffff);
  const wrongMagic = input.slice(); wrongMagic[0] = 0; expect(() => decodeChunk(wrongMagic, DEFAULT_LIMITS)).toThrow('PROTOCOL_UNSUPPORTED');
  const wrongLength = input.slice(); new DataView(wrongLength.buffer).setUint32(40, 0); expect(() => decodeChunk(wrongLength, DEFAULT_LIMITS)).toThrow('INVALID_MESSAGE');
  expect(() => encodeChunk(id, controlId, 0x100000000, new Uint8Array([1]))).toThrow();
  expect(() => encodeChunk(id, controlId, 0, new Uint8Array(DEFAULT_LIMITS.chunkBytes + 1))).toThrow('LIMIT_EXCEEDED');
  const offset = new Uint8Array(input.length + 2); offset.set(input, 1); expect(decodeChunk(offset.subarray(1, -1), DEFAULT_LIMITS).data).toEqual(new Uint8Array([7]));
});
test('transfer faults close and drop every buffer; all four queue slots count against credit', async () => {
  const receiver = new TransferReceiver(id, controlId, 4, DEFAULT_LIMITS); receiver.grant(4);
  for (let i = 0; i < 4; i++) receiver.receive(encodeChunk(id, controlId, i, new Uint8Array([i])));
  expect(receiver.bufferedBytes).toBe(4); expect(() => receiver.grant(1)).toThrow('BACKPRESSURE'); expect(receiver.bufferedBytes).toBe(0); await expect(receiver.next()).rejects.toThrow('BACKPRESSURE');
  const stale = new TransferReceiver(id, controlId, 1, DEFAULT_LIMITS); stale.grant(1); expect(() => stale.receive(encodeChunk(id, runtimeId, 0, new Uint8Array([1])))).toThrow('STALE_CONTROL');
  const tooMuch = new TransferReceiver(id, controlId, 1, DEFAULT_LIMITS); tooMuch.grant(1); expect(() => tooMuch.receive(encodeChunk(id, controlId, 0, new Uint8Array([1, 2])))).toThrow('LIMIT_EXCEEDED');
  const errored = new TransferReceiver(id, controlId, 1, DEFAULT_LIMITS); const pending = errored.next(); expect(() => errored.end(0, { code: 'OUT_OF_SCOPE', message: 'gone', retryable: false })).toThrow('OUT_OF_SCOPE'); await expect(pending).rejects.toMatchObject({ code: 'OUT_OF_SCOPE', retryable: false });
  const empty = new TransferReceiver(id, controlId, 0, DEFAULT_LIMITS); empty.end(0); expect((await empty.next()).done).toBe(true);
});
test('exact JSON byte boundary accepts ASCII, multibyte and surrogate pairs', () => {
  const message = { v: 1, type: 'event', id, fence, value: 'é😀' }; const text = JSON.stringify(message); const bytes = new TextEncoder().encode(text).length;
  expect(parseHost(text, { ...DEFAULT_LIMITS, jsonBytes: bytes })).toEqual(message);
  expect(() => parseHost(text, { ...DEFAULT_LIMITS, jsonBytes: bytes - 1 })).toThrow('LIMIT_EXCEEDED');
});

test('abort after successful wire end still releases unconsumed queued bytes', async () => {
  const abort = new AbortController(); const receiver = new TransferReceiver(id, controlId, 1, DEFAULT_LIMITS, abort.signal);
  receiver.grant(1); receiver.receive(encodeChunk(id, controlId, 0, new Uint8Array([1]))); receiver.end(1); abort.abort();
  expect(receiver.bufferedBytes).toBe(0); await expect(receiver.next()).rejects.toThrow('TRANSFER_CLOSED');
});
test('single pending consumer and explicit disposal settle without retaining frames', async () => {
  const receiver = new TransferReceiver(id, controlId, 1, DEFAULT_LIMITS); const first = receiver.next();
  await expect(receiver.next()).rejects.toThrow('INVALID_MESSAGE'); receiver.dispose(); expect((await first).done).toBe(true);
  expect(() => receiver.grant(1)).toThrow('TRANSFER_CLOSED'); expect(() => receiver.end(0)).toThrow('TRANSFER_CLOSED');
});

test.each([
  ['session.page', 'throughSeq', 0, Number.MAX_SAFE_INTEGER],
  ['session.page', 'beforeSeq', 0, Number.MAX_SAFE_INTEGER],
  ['session.page', 'maxMessages', 1, Number.MAX_SAFE_INTEGER],
  ['file.changes', 'seq', 0, Number.MAX_SAFE_INTEGER],
  ['file.diff', 'index', 0, Number.MAX_SAFE_INTEGER],
  ['file.diff', 'seq', 0, Number.MAX_SAFE_INTEGER],
] as const)('%s.%s safe integer boundaries', (op, field, min, max) => {
  const command = op === 'session.page' ? { op, sessionId: 's', throughSeq: 0, maxMessages: 1 } : op === 'file.diff' ? { op, sessionId: 's', seq: 0, index: 0 } : { op, sessionId: 's', seq: 0 };
  for (const value of [min, max]) expect(parse({ ...call, command: { ...command, [field]: value } })).toBeDefined();
  for (const value of [min - 1, max + 1, 0.5]) expect(() => parse({ ...call, command: { ...command, [field]: value } })).toThrow();
});
test('bounded strings/content and nested JSON reject each edge beyond the schema', () => {
  expect(parse({ ...call, command: { op: 'session.list', workspaceId: 'a'.repeat(4096) } })).toBeDefined();
  for (const workspaceId of ['', 'a'.repeat(4097)]) expect(() => parse({ ...call, command: { op: 'session.list', workspaceId } })).toThrow();
  const command = { op: 'session.prompt', sessionId: 's', requestId: id, mode: 'steer', content: Array.from({ length: 1024 }, () => ({ kind: 'text', text: '' })) };
  expect(parse({ ...call, command })).toBeDefined();
  for (const content of [[], [...command.content, { kind: 'text', text: '' }], [{ kind: 'text', text: '', extra: true }]]) expect(() => parse({ ...call, command: { ...command, content } })).toThrow();
  const answer = '['.repeat(65) + 'null' + ']'.repeat(65);
  expect(() => parseController(`{"v":1,"type":"call","id":"${id}","fence":${JSON.stringify(fence)},"command":{"op":"interaction.answer","deliveryId":"d","answer":${answer}}}`, DEFAULT_LIMITS)).toThrow();
});
test('handshake version/capability bounds and selected v1 are strict', () => {
  const hello = { v: 1, type: 'host.hello', instanceId: id, runtimeId, versions: [1], capabilities: [], authEpoch: 1, linkVerifier: 'a'.repeat(64), enabled: false };
  for (const versions of [[1], Array(32).fill(65535)]) expect(parseHandshake(JSON.stringify({ ...hello, versions }), DEFAULT_LIMITS)).toBeDefined();
  for (const versions of [[], Array(33).fill(1), [0], [65536], [0.5]]) expect(() => parseHandshake(JSON.stringify({ ...hello, versions }), DEFAULT_LIMITS)).toThrow();
  expect(parseHandshake(JSON.stringify({ ...hello, capabilities: Array(128).fill('a') }), DEFAULT_LIMITS)).toBeDefined();
  expect(() => parseHandshake(JSON.stringify({ ...hello, capabilities: Array(129).fill('a') }), DEFAULT_LIMITS)).toThrow();
  for (const linkVerifier of ['a'.repeat(63), 'A'.repeat(64), 'g'.repeat(64)]) expect(() => parseHandshake(JSON.stringify({ ...hello, linkVerifier }), DEFAULT_LIMITS)).toThrow();
});
test('uploads/end accept zero bytes/chunks and exact maximum; numeric fields remain safe', () => {
  const open = { v: 1, type: 'upload.open', id, fence, sessionId: 's', name: 'n', mediaType: 'x', bytes: 0 };
  expect(parse(open)).toBeDefined();
  for (const bytes of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) expect(() => parse({ ...open, bytes })).toThrow();
  for (const chunks of [0, Number.MAX_SAFE_INTEGER]) expect(parse({ v: 1, type: 'upload.end', id, fence, chunks })).toBeDefined();
  for (const chunks of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) expect(() => parse({ v: 1, type: 'upload.end', id, fence, chunks })).toThrow();
  expect(parse({ ...call, command: { op: 'file.read', sessionId: 's', path: 'x', offset: Number.MAX_SAFE_INTEGER, length: 0 } })).toBeDefined();
  expect(() => parse({ ...call, command: { op: 'file.read', sessionId: 's', path: 'x', offset: Number.MAX_SAFE_INTEGER, length: 1 } })).toThrow();
});
test('prompt uncertain retry is centrally true-only reconciliation metadata', () => {
  const command = { op: 'session.prompt', sessionId: 's', requestId: id, mode: 'queue', content: [{ kind: 'text', text: 'hi' }], reconcileOnly: true }
  expect(parse({ ...call, command })).toBeDefined()
  for (const reconcileOnly of [false, null, 'true', 1]) expect(() => parse({ ...call, command: { ...command, reconcileOnly } })).toThrow('INVALID_MESSAGE')
})
