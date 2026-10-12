import type { SelectedUiProfile } from './ui-profile.js';
/** Only finite, plain JSON values are accepted at runtime by the schemas. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface Fence { instanceId: string; authEpoch: number; runtimeId: string; controlId: string }
export const ERROR_CODES = ['AUTH_REVOKED', 'HOST_OFFLINE', 'HOST_ID_IN_USE', 'REMOTE_BUSY', 'REMOTE_REPLACED', 'STALE_CONTROL', 'STALE_ACTION', 'OUT_OF_SCOPE', 'WRITER_HELD', 'BACKPRESSURE', 'LIMIT_EXCEEDED', 'RESULT_UNCERTAIN', 'PROTOCOL_UNSUPPORTED', 'RESYNC_REQUIRED', 'INVALID_MESSAGE', 'TRANSFER_CLOSED', 'TRANSFER_TIMEOUT'] as const;
export type ErrorCode = typeof ERROR_CODES[number];
export interface Fault { code: string; message: string; retryable: boolean }
export class ProtocolError extends Error implements Fault {
  constructor(public readonly code: string, message = code, public readonly retryable = false) { super(message.includes(code) ? message : `${code}: ${message}`); this.name = 'ProtocolError'; }
}
export type Result<T> = { ok: true; value: T } | { ok: false; error: Fault };
export type ContentPart = { kind: 'text'; text: string } | { kind: 'upload'; receiptId: string; name: string; mediaType: string };
export interface TurnWindow { minMessages: number; minTurns: number }
export type ManagementAction =
  | { kind: 'session.rename'; sessionId: string; title: string }
  | { kind: 'session.fork'; sessionId: string; atSeq?: number }
  | { kind: 'workspace.rename'; workspaceId: string; title: string }
  | { kind: 'workspace.delete'; workspaceId: string }
  | { kind: 'workspace.insertBefore'; workspaceId: string; beforeWorkspaceId?: string }
  | { kind: 'workspace.archiveSession'; sessionId: string; stopActivity?: boolean }
  | { kind: 'workspace.unarchiveSession' | 'workspace.pinSession' | 'workspace.unpinSession'; sessionId: string };
export type Command =
  | { op: 'ui.manage'; action: ManagementAction }
  | { op: 'ui.catalog' }
  | { op: 'ui.search'; query: string }
  | { op: 'session.list'; workspaceId: string; cursor?: string }
  | { op: 'session.create'; workspaceId: string; sessionId: string }
  | { op: 'session.prompt'; sessionId: string; requestId: string; mode: 'queue' | 'steer'; content: ContentPart[]; clientTimeZone?: string; reconcileOnly?: true }
  | { op: 'session.page'; sessionId: string; throughSeq: number; beforeSeq?: number; maxMessages: number; turnWindow?: TurnWindow }
  | { op: 'ui.read'; view: 'host-facts' | 'conversation-settings' }
  | { op: 'ui.read'; view: 'session'; sessionId: string }
  | { op: 'session.queue'; sessionId: string; itemId: string; stopToken?: string; action: { kind: 'edit'; content: { type: 'text'; text: string }[] } | { kind: 'remove' } | { kind: 'steer' } }
  | { op: 'session.stop'; sessionId: string; stopToken: string }
  | { op: 'interaction.delegate'; deliveryId: string }
  | { op: 'interaction.answer'; deliveryId: string; answer: Json }
  | { op: 'file.stat'; sessionId: string; path: string; baseFile?: string }
  | { op: 'file.text'; sessionId: string; path: string; version: string; offset: number; limit: number }
  | { op: 'file.read'; sessionId: string; path: string; offset: number; length: number; version?: string }
  | { op: 'file.changes'; sessionId: string; seq: number }
  | { op: 'file.diff'; sessionId: string; seq: number; index: number };
export type Watch = { topic: 'file'; sessionId: string; path: string } | { topic: 'workspaces' } | { topic: 'sessions' } | { topic: 'session'; sessionId: string; maxMessages: number; turnWindow?: TurnWindow } | { topic: 'interactions' };
type Wire<T> = { v: 1 } & T;
export type ControllerMessage = Wire<
  | { type: 'call'; id: string; fence: Fence; command: Command; fragments?: true }
  | { type: 'watch'; id: string; fence: Fence; watch: Watch; fragments?: true }
  | { type: 'cancel'; id: string; fence: Fence }
  | { type: 'upload.open'; id: string; fence: Fence; sessionId: string; name: string; mediaType: string; bytes: number }
  | { type: 'upload.end'; id: string; fence: Fence; chunks: number }
  | { type: 'download.credit'; id: string; fence: Fence; chunks: number }
  | { type: 'heartbeat'; fence: Fence }
>;
/** file.read's successful result is the download opener; transferId differs from call id. */
export interface DownloadMetadata { transferId: string; name: string; mediaType: string; bytes: number; offset: number; eof: boolean }
export type JsonFragment = Wire<{ type: 'json.fragment'; id: string; fence: Fence; logicalType: 'result' | 'event'; index: number; parts: number; bytes: number; data: string }>;
export type HostMessage = Wire<
  | { type: 'result'; id: string; fence: Fence; result: Result<Json> }
  | { type: 'event'; id: string; fence: Fence; value: Json }
  | { type: 'end'; id: string; fence: Fence; error?: Fault }
  | { type: 'upload.credit'; id: string; fence: Fence; chunks: number }
  | { type: 'download.end'; id: string; fence: Fence; chunks: number; error?: Fault }
 > | JsonFragment;
export type HandshakeMessage = Wire<
  | { type: 'host.hello'; instanceId: string; runtimeId: string; versions: number[]; capabilities: string[]; authEpoch: number; linkVerifier: string; enabled: boolean; limits?: Limits }
  | { type: 'relay.ack'; version: number; authEpoch: number; linkVerifier: string; enabled: boolean }
  | { type: 'attach'; id: string; leaseId: string; fence: Fence }
  | { type: 'host.attached'; id: string; fence: Fence }
  | { type: 'ready'; fence: Fence; uiProfile?: SelectedUiProfile }
  | { type: 'browser.hello'; versions: number[]; uiApi?: 1; takeover?: true; resume?: { id: string; secret: string } }
  | { type: 'browser.lease'; id: string; resumeSecret: string; fence: Fence; expiresAt: number }
  | { type: 'browser.lease-ack'; id: string }
  | { type: 'relay.config'; limits: Limits; heartbeatMs: number; leaseTtlMs: number }
  | { type: 'host.auth'; authEpoch: number; linkVerifier: string; enabled: boolean }
  | { type: 'detach'; fence: Fence }
  | { type: 'fault'; error: Fault }
>;
export interface Clock { now(): number }
export interface Limits { jsonBytes: number; chunkBytes: number; fileBytes: number; calls: number; streams: number; uploads: number; bufferedBytes: number; callTimeoutMs: number; transferIdleMs: number }
