import { ProtocolError, type Limits } from './types.js';
export const DEFAULT_LIMITS: Readonly<Limits> = Object.freeze({ jsonBytes: 256 * 1024, chunkBytes: 64 * 1024, fileBytes: 32 * 1024 * 1024, calls: 16, streams: 16, uploads: 2, bufferedBytes: 4 * 1024 * 1024, callTimeoutMs: 30000, transferIdleMs: 60000 });
export const MAX_IN_FLIGHT_CHUNKS = 4;
export const MAX_READ_BYTES = 1024 * 1024;
export function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new ProtocolError('INVALID_MESSAGE', `Expected integer in [${min}, ${max}]`);
}
export function validateLimits(limits: Limits): Limits {
  for (const key of Object.keys(DEFAULT_LIMITS) as (keyof Limits)[]) integer(limits[key], 1);
  // Byte and timer bounds must fit the wire format and runtime timeout implementation.
  integer(limits.chunkBytes, 1, 0xffffffff); integer(limits.callTimeoutMs, 1, 0x7fffffff); integer(limits.transferIdleMs, 1, 0x7fffffff);
  return { ...limits };
}
export function effectiveLimits(configured: Limits, host: Partial<Limits>): Limits {
  const result = validateLimits(configured);
  for (const key of Object.keys(DEFAULT_LIMITS) as (keyof Limits)[]) if (host[key] !== undefined) { integer(host[key], 1); result[key] = Math.min(result[key], host[key]!); }
  return validateLimits(result);
}
export function validateHeartbeat(intervalMs: number, lostAfterMs: number): void {
  integer(intervalMs, 1, 0x7fffffff); integer(lostAfterMs, 1, 0x7fffffff);
  if (lostAfterMs <= intervalMs) throw new ProtocolError('INVALID_MESSAGE', 'Heartbeat loss deadline must exceed interval');
}
/** Count UTF-8 bytes incrementally, without allocating an encoded copy of untrusted text. */
export function checkJsonLength(text: string, limit: number): void {
  integer(limit, 1);
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) bytes++; else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) { bytes += 4; i++; }
    else bytes += 3;
    if (bytes > limit) throw new ProtocolError('LIMIT_EXCEEDED', `JSON exceeds ${limit} bytes`);
  }
}
