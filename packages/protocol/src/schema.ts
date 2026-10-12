import { parseSelectedUiProfile } from './ui-profile.js';
import { MAX_LOGICAL_JSON_BYTES, MAX_JSON_PARTS, fragmentableRead } from './json-fragments.js';
import { checkJsonLength, integer, MAX_IN_FLIGHT_CHUNKS, MAX_READ_BYTES, validateLimits, validateHeartbeat, DEFAULT_LIMITS } from './limits.js';
import { ProtocolError, type ControllerMessage, type DownloadMetadata, type Fence, type HandshakeMessage, type HostMessage, type Json, type Limits } from './types.js';
type Check = (value: unknown) => void;
function invalid(): never { throw new ProtocolError('INVALID_MESSAGE'); }
const text: Check = value => { if (typeof value !== 'string') invalid(); };
const nonempty: Check = value => { text(value); if ((value as string).length === 0 || (value as string).length > 4096) invalid(); };
const bool: Check = value => { if (typeof value !== 'boolean') invalid(); };
const uint: Check = value => integer(value);
const count: Check = value => integer(value, 1);
const chunks: Check = value => integer(value, 1, MAX_IN_FLIGHT_CHUNKS);
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function validateId(value: unknown): asserts value is string { if (typeof value !== 'string' || !UUID_PATTERN.test(value)) invalid(); }
const literal = (expected: unknown): Check => value => { if (value !== expected) invalid(); };
const choice = (...allowed: string[]): Check => value => { if (typeof value !== 'string' || !allowed.includes(value)) invalid(); };
const forbidden = new Set(['__proto__', 'prototype', 'constructor', 'localhostToken', 'localToken']);
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) invalid();
  const result = value as Record<string, unknown>;
  for (const key of Reflect.ownKeys(result)) {
    if (typeof key !== 'string' || forbidden.has(key)) invalid();
    const descriptor = Object.getOwnPropertyDescriptor(result, key)!;
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) invalid();
  }
  return result;
}
function shape(value: unknown, required: Record<string, Check>, optional: Record<string, Check> = {}): void {
  const obj = object(value);
  for (const key of Object.keys(obj)) if (!Object.hasOwn(required, key) && !Object.hasOwn(optional, key)) invalid();
  for (const [key, check] of Object.entries(required)) { if (!Object.hasOwn(obj, key)) invalid(); check(obj[key]); }
  for (const [key, check] of Object.entries(optional)) if (Object.hasOwn(obj, key)) check(obj[key]);
}
function array(check: Check, max = 1024, min = 0): Check {
  return value => { if (!Array.isArray(value) || value.length > max || value.length < min) invalid(); for (const item of value as unknown[]) check(item); };
}
export function validateJson(value: unknown): Json {
  const visit = (item: unknown, depth: number): void => {
    if (depth > 64) invalid();
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number') { if (!Number.isFinite(item)) invalid(); return; }
    if (Array.isArray(item)) {
      if (Object.getPrototypeOf(item) !== Array.prototype || Reflect.ownKeys(item).length !== item.length + 1) invalid();
      for (let i = 0; i < item.length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(i));
        if (!descriptor) invalid();
        if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) invalid();
        visit(descriptor.value, depth + 1);
      }
      return;
    }
    for (const child of Object.values(object(item))) visit(child, depth + 1);
  };
  visit(value, 0); return value as Json;
}
const json: Check = value => { validateJson(value); };
const fence: Check = value => { shape(value, { instanceId: validateId, runtimeId: validateId, controlId: validateId, authEpoch: count }); };
export function validateFence(value: unknown): Fence { fence(value); return value as Fence; }
const fault: Check = value => shape(value, { code: nonempty, message: text, retryable: bool });
const result: Check = value => {
  const obj = object(value);
  if (obj.ok === true) shape(value, { ok: literal(true), value: json });
  else shape(value, { ok: literal(false), error: fault });
};
const content: Check = value => {
  const obj = object(value);
  if (obj.kind === 'text') shape(value, { kind: literal('text'), text });
  else shape(value, { kind: literal('upload'), receiptId: nonempty, name: nonempty, mediaType: nonempty });
};
/** Reused by the native browser route; the Host validates the wire independently. */
export function validateManagementAction(value: unknown): import('./types.js').ManagementAction {
  const obj = object(value), kind = literal(obj.kind);
  switch (obj.kind) {
    case 'session.rename': shape(value, { kind, sessionId: nonempty, title: nonempty }); break;
    case 'session.fork': shape(value, { kind, sessionId: nonempty }, { atSeq: uint }); break;
    case 'workspace.rename': shape(value, { kind, workspaceId: nonempty, title: nonempty }); break;
    case 'workspace.delete': shape(value, { kind, workspaceId: nonempty }); break;
    case 'workspace.insertBefore': shape(value, { kind, workspaceId: nonempty }, { beforeWorkspaceId: nonempty }); break;
    case 'workspace.archiveSession': shape(value, { kind, sessionId: nonempty }, { stopActivity: bool }); break;
    case 'workspace.unarchiveSession': case 'workspace.pinSession': case 'workspace.unpinSession': shape(value, { kind, sessionId: nonempty }); break;
    default: invalid();
  }
  return value as import('./types.js').ManagementAction;
}
function turnWindow(maxMessages: unknown): Check { return value => { shape(value, { minMessages: n => integer(n, 0, maxMessages as number), minTurns: uint }); }; }
function command(value: unknown, limits: Limits): void {
  const obj = object(value);
  const sessionId = nonempty;
  switch (obj.op) {
    case 'ui.manage': shape(value, { op: literal(obj.op), action: action => { validateManagementAction(action); } }); break;
    case 'ui.catalog': shape(value, { op: literal(obj.op) }); break;
    case 'ui.search': shape(value, { op: literal(obj.op), query: nonempty }); break;
    case 'session.list': shape(value, { op: literal(obj.op), workspaceId: nonempty }, { cursor: nonempty }); break;
    case 'session.create': shape(value, { op: literal(obj.op), workspaceId: nonempty, sessionId }); break;
    case 'session.prompt': shape(value, { op: literal(obj.op), sessionId, requestId: validateId, mode: choice('queue', 'steer'), content: array(content, 1024, 1) }, { clientTimeZone: nonempty, reconcileOnly: literal(true) }); break;
    case 'session.page': shape(value, { op: literal(obj.op), sessionId, throughSeq: uint, maxMessages: count }, { beforeSeq: uint, turnWindow: turnWindow(obj.maxMessages) }); break;
    case 'ui.read':
      if (obj.view === 'session') shape(value, { op: literal(obj.op), view: literal('session'), sessionId });
      else shape(value, { op: literal(obj.op), view: choice('host-facts', 'conversation-settings') });
      break;
    case 'session.queue': shape(value, { op: literal(obj.op), sessionId, itemId: nonempty, action: action => {
      const a = object(action);
      if (a.kind === 'edit') {
        shape(a, { kind: literal('edit'), content: array(part => shape(part, { type: literal('text'), text }), 1024, 1) });
        if (!(a.content as {text: string}[]).some(part => part.text.trim().length)) invalid();
      } else shape(a, { kind: choice('remove', 'steer') });
    } }, { stopToken: nonempty }); break;
    case 'session.stop': shape(value, { op: literal(obj.op), sessionId, stopToken: nonempty }); break;
    case 'interaction.delegate': shape(value, { op: literal(obj.op), deliveryId: nonempty }); break;
    case 'interaction.answer': shape(value, { op: literal(obj.op), deliveryId: nonempty, answer: json }); break;
    case 'file.stat': shape(value, { op: literal(obj.op), sessionId, path: nonempty }, { baseFile: nonempty }); break;
    case 'file.text': shape(value, { op: literal(obj.op), sessionId, path: nonempty, version: nonempty, offset: count, limit: n => integer(n, 1, 5000) }); if ((obj.offset as number) > Number.MAX_SAFE_INTEGER - (obj.limit as number)) invalid(); break;
    case 'file.read': shape(value, { op: literal(obj.op), sessionId, path: nonempty, offset: uint, length: n => integer(n, 0, Math.min(MAX_READ_BYTES, limits.fileBytes)) }, { version: nonempty }); if ((obj.offset as number) > Number.MAX_SAFE_INTEGER - (obj.length as number)) invalid(); break;
    case 'file.changes': shape(value, { op: literal(obj.op), sessionId, seq: uint }); break;
    case 'file.diff': shape(value, { op: literal(obj.op), sessionId, seq: uint, index: uint }); break;
    default: invalid();
  }
}
const watch: Check = value => {
  const obj = object(value);
  if (obj.topic === 'file') shape(value, { topic: literal('file'), sessionId: nonempty, path: nonempty });
  else if (obj.topic === 'session') shape(value, { topic: literal('session'), sessionId: nonempty, maxMessages: count }, { turnWindow: turnWindow(obj.maxMessages) });
  else shape(value, { topic: choice('workspaces', 'sessions', 'interactions') });
};
function parse(text: string, limits: Limits): Record<string, unknown> {
  validateLimits(limits); checkJsonLength(text, limits.jsonBytes);
  let value: unknown;
  try { value = JSON.parse(text); } catch { invalid(); }
  const obj = object(value);
  if (obj.v !== 1) throw new ProtocolError('PROTOCOL_UNSUPPORTED');
  return obj;
}
export function parseController(text: string, limits: Limits): ControllerMessage {
  const value = parse(text, limits); const base = { v: literal(1), type: literal(value.type), id: validateId, fence };
  switch (value.type) {
    case 'call':
      shape(value, { ...base, command: commandValue => command(commandValue, limits) }, { fragments: literal(true) });
      if (value.fragments && !fragmentableRead(value.command as import('./types.js').Command)) invalid();
      break;
    case 'watch': shape(value, { ...base, watch }, { fragments: literal(true) }); break;
    case 'cancel': shape(value, base); break;
    case 'upload.open': shape(value, { ...base, sessionId: nonempty, name: nonempty, mediaType: nonempty, bytes: n => integer(n, 0, limits.fileBytes) }); break;
    case 'upload.end': shape(value, { ...base, chunks: uint }); break;
    case 'download.credit': shape(value, { ...base, chunks }); break;
    case 'heartbeat': shape(value, { v: literal(1), type: literal(value.type), fence }); break;
    default: invalid();
  }
  return value as unknown as ControllerMessage;
}
export function parseHost(input: string, limits: Limits): HostMessage {
  const value = parse(input, limits); const base = { v: literal(1), type: literal(value.type), id: validateId, fence };
  switch (value.type) {
    case 'result': shape(value, { ...base, result }); break;
    case 'event': shape(value, { ...base, value: json }); break;
    case 'json.fragment':
      shape(value, { ...base, logicalType: choice('result', 'event'), index: uint, parts: n => integer(n, 2, MAX_JSON_PARTS), bytes: n => integer(n, 1, MAX_LOGICAL_JSON_BYTES), data: text });
      if ((value.index as number) >= (value.parts as number) || !(value.data as string).length) invalid();
      break;
    case 'end': shape(value, base, { error: fault }); break;
    case 'upload.credit': shape(value, { ...base, chunks }); break;
    case 'download.end': shape(value, { ...base, chunks: uint }, { error: fault }); break;
    default: invalid();
  }
  return value as unknown as HostMessage;
}
export function validateDownloadMetadata(value: unknown, limits: Limits): DownloadMetadata {
  validateLimits(limits);
  shape(value, { transferId: validateId, name: nonempty, mediaType: nonempty, bytes: n => integer(n, 0, Math.min(MAX_READ_BYTES, limits.fileBytes)), offset: uint, eof: bool });
  const metadata = value as DownloadMetadata;
  if (metadata.offset > Number.MAX_SAFE_INTEGER - metadata.bytes) invalid();
  return metadata;
}
export function parseHandshake(text: string, limits: Limits): HandshakeMessage {
  const value = parse(text, limits); const base = { v: literal(1), type: literal(value.type) };
  const verifier: Check = v => { if (typeof v !== 'string' || !/^[0-9a-f]{64}$/.test(v)) invalid(); };
  const secret: Check = v => { if (typeof v !== 'string' || !/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(v)) invalid(); };
  const wireLimits: Check = v => { shape(v, Object.fromEntries(Object.keys(DEFAULT_LIMITS).map(k => [k, count]))); validateLimits(v as Limits); };
  switch (value.type) {
    case 'browser.hello': shape(value, { ...base, versions: array(n => integer(n, 1, 0xffff), 32, 1) }, { uiApi: literal(1), takeover: literal(true), resume: v => shape(v, { id: validateId, secret }) }); break;
    case 'browser.lease': shape(value, { ...base, id: validateId, resumeSecret: secret, fence, expiresAt: uint }); break;
    case 'browser.lease-ack': shape(value, { ...base, id: validateId }); break;
    case 'relay.config': shape(value, { ...base, limits: wireLimits, heartbeatMs: count, leaseTtlMs: count }); validateHeartbeat(value.heartbeatMs as number, value.leaseTtlMs as number); break;
    case 'host.auth': shape(value, { ...base, authEpoch: count, linkVerifier: verifier, enabled: bool }); break;
    case 'detach': shape(value, { ...base, fence }); break;
    case 'fault': shape(value, { ...base, error: fault }); break;
    case 'host.hello': shape(value, { ...base, instanceId: validateId, runtimeId: validateId, versions: array(n => integer(n, 1, 0xffff), 32, 1), capabilities: array(nonempty, 128), authEpoch: count, linkVerifier: verifier, enabled: bool }, { limits: wireLimits }); break;
    case 'relay.ack': shape(value, { ...base, version: n => integer(n, 1, 0xffff), authEpoch: count, linkVerifier: verifier, enabled: bool }); break;
    case 'attach': shape(value, { ...base, id: validateId, leaseId: validateId, fence }); break;
    case 'host.attached': shape(value, { ...base, id: validateId, fence }); break;
    case 'ready': shape(value, { ...base, fence }, { uiProfile: v => { parseSelectedUiProfile(v); } });
      if (value.uiProfile && (value.uiProfile as {runtimeId: string}).runtimeId !== (value.fence as Fence).runtimeId) invalid(); break;
    default: invalid();
  }
  return value as unknown as HandshakeMessage;
}
