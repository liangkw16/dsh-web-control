import { CURRENT_FILES_CAPABILITY } from './current-files.js'
import { ProtocolError, type Json } from './types.js'
import { validateId, validateJson } from './schema.js'
import { LARGE_JSON_CAPABILITY } from './json-fragments.js'
export const NATIVE_UI_MARKER = 'native-ui/rc2/1'
export const UI_CAPABILITIES = ['session', 'interactions', 'uploads', 'recorded-diff', 'session-queue', 'ui-read'] as const
export const MANAGEMENT_CAPABILITY = 'workspace-management'
export interface HostUiProfile { schema: 1; dshVersion: '0.2.0-rc.2'; adapter: 'rc2-native-1'; uiApi: 1; capabilities: string[] }
export interface SelectedUiProfile { host: HostUiProfile; runtimeId: string; uiRevision: string }
export type UiSelection = { kind: 'legacy'; runtimeId: string } | { kind: 'native'; profile: SelectedUiProfile } | { kind: 'unavailable'; code: 'HOST_OFFLINE' | 'PROTOCOL_UNSUPPORTED' }
export const RC2_UI_PROFILE: HostUiProfile = Object.freeze({ schema: 1, dshVersion: '0.2.0-rc.2', adapter: 'rc2-native-1', uiApi: 1, capabilities: [...UI_CAPABILITIES] })
function invalid(): never { throw new ProtocolError('PROTOCOL_UNSUPPORTED') }
function record(value: unknown, required: string[], optional: string[] = []): Record<string, Json> {
  const v = validateJson(value)
  if (!v || typeof v !== 'object' || Array.isArray(v) || required.some(key => !Object.hasOwn(v, key)) || Object.keys(v).some(key => !required.includes(key) && !optional.includes(key))) invalid()
  return v
}
function text(value: unknown): asserts value is string { if (typeof value !== 'string' || !value.length || value.length > 4096) invalid() }
function uint(value: unknown): void { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalid() }
export function parseHostUiProfile(value: unknown): HostUiProfile {
  const v = record(value, ['schema', 'dshVersion', 'adapter', 'uiApi', 'capabilities'])
  if (v.schema !== 1 || v.dshVersion !== '0.2.0-rc.2' || v.adapter !== 'rc2-native-1' || v.uiApi !== 1 || !Array.isArray(v.capabilities)
    || new Set(v.capabilities).size !== v.capabilities.length || v.capabilities.some(c => ![...UI_CAPABILITIES, MANAGEMENT_CAPABILITY, LARGE_JSON_CAPABILITY, CURRENT_FILES_CAPABILITY].includes(c as string)) || UI_CAPABILITIES.some(c => !(v.capabilities as Json[]).includes(c))) invalid()
  return { schema: 1, dshVersion: v.dshVersion, adapter: v.adapter, uiApi: 1, capabilities: [...v.capabilities] as string[] }
}
export function parseSelectedUiProfile(value: unknown): SelectedUiProfile {
  const v = record(value, ['host', 'runtimeId', 'uiRevision'])
  validateId(v.runtimeId)
  if (typeof v.uiRevision !== 'string' || !/^[0-9a-f]{64}$/.test(v.uiRevision)) invalid()
  return { host: parseHostUiProfile(v.host), runtimeId: v.runtimeId, uiRevision: v.uiRevision }
}
export function parseUiSelection(value: unknown): UiSelection {
  const v = record(value, ['kind'], ['profile', 'runtimeId', 'code'])
  switch (v.kind) {
    case 'legacy': record(v, ['kind', 'runtimeId']); validateId(v.runtimeId); return { kind: 'legacy', runtimeId: v.runtimeId }
    case 'native': record(v, ['kind', 'profile']); return { kind: 'native', profile: parseSelectedUiProfile(v.profile) }
    case 'unavailable': record(v, ['kind', 'code']); if (v.code !== 'HOST_OFFLINE' && v.code !== 'PROTOCOL_UNSUPPORTED') invalid(); return { kind: 'unavailable', code: v.code }
    default: invalid()
  }
}
/** The fixed marker declares a complete adapter, never a partial or inferred future version. */
export function hostUiProfileFromCapabilities(capabilities: readonly string[]): HostUiProfile | null {
  const markers = capabilities.filter(c => c.startsWith('native-ui/'))
  if (!markers.length) return null
  if (markers.length !== 1 || markers[0] !== NATIVE_UI_MARKER || UI_CAPABILITIES.some(c => !capabilities.includes(c))) invalid()
  return parseHostUiProfile({ ...RC2_UI_PROFILE, capabilities: [...UI_CAPABILITIES, ...[MANAGEMENT_CAPABILITY, LARGE_JSON_CAPABILITY, CURRENT_FILES_CAPABILITY].filter(capability => capabilities.includes(capability))] })
}
export type UiReadView = 'host-facts' | 'conversation-settings' | 'session'
export function parseUiReadResult(view: UiReadView, value: unknown): Json {
  if (view === 'host-facts') {
    const v = record(value, ['home']); text(v.home); return v
  }
  if (view === 'conversation-settings') {
    const v = record(value, ['ns', 'revision', 'busyEnter']); uint(v.revision)
    if (v.ns !== 'ui-conversation' || (v.busyEnter !== 'queue' && v.busyEnter !== 'steer')) invalid()
    return v
  }
  if (view === 'session') {
    const v = record(value, ['sessionId', 'createdAt'], ['cwd']); text(v.sessionId); uint(v.createdAt); if ('cwd' in v) text(v.cwd); return v
  }
  invalid()
}
