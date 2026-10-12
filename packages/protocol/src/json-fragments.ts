import { checkJsonLength } from './limits.js'
import { parseHost, validateJson } from './schema.js'
import { ProtocolError, type Command, type HostMessage, type JsonFragment, type Limits } from './types.js'

export const LARGE_JSON_CAPABILITY = 'large-json-v1'
// Leave space for join/parse ownership and physical frames in a 4 MiB receiver.
export const MAX_LOGICAL_JSON_BYTES = 7 * 256 * 1024
export const MAX_JSON_PARTS = 256
export const fragmentableRead = (command: Command): boolean => ['ui.catalog', 'ui.search', 'session.list', 'session.page', 'file.changes', 'file.diff', 'file.text'].includes(command.op)
export const jsonBytes = (text: string): number => new TextEncoder().encode(text).byteLength

/** Serialize validated JSON in bounded pieces, without a second full-body string.
 * String chunks preserve surrogate pairs; each piece is escaped by JSON.stringify.
 */
function* jsonTokens(value: import('./types.js').Json): Generator<string> {
  if (typeof value === 'string') {
    yield '"'
    for (let start = 0; start < value.length;) {
      let end = Math.min(value.length, start + 4096)
      if (value.charCodeAt(end - 1) >= 0xd800 && value.charCodeAt(end - 1) <= 0xdbff && value.charCodeAt(end) >= 0xdc00 && value.charCodeAt(end) <= 0xdfff) end--
      yield JSON.stringify(value.slice(start, end)).slice(1, -1); start = end
    }
    yield '"'
  } else if (value === null || typeof value !== 'object') yield JSON.stringify(value)
  else {
    const array = Array.isArray(value)
    yield array ? '[' : '{'
    let first = true
    for (const key of Object.keys(value)) {
      if (!first) yield ','; first = false
      if (!array) { yield* jsonTokens(key); yield ':' }
      yield* jsonTokens((value as Record<string, import('./types.js').Json>)[key])
    }
    yield array ? ']' : '}'
  }
}
function* encodedParts(value: import('./types.js').Json, width: number): Generator<string> {
  let pending = ''
  for (const token of jsonTokens(value)) {
    for (let offset = 0; offset < token.length;) {
      let end = Math.min(token.length, offset + width - pending.length)
      if (token.charCodeAt(end - 1) >= 0xd800 && token.charCodeAt(end - 1) <= 0xdbff && token.charCodeAt(end) >= 0xdc00 && token.charCodeAt(end) <= 0xdfff) end--
      if (end === offset) { yield pending; pending = ''; continue }
      pending += token.slice(offset, end); offset = end
      if (pending.length >= width - 1) { yield pending; pending = '' }
    }
  }
  if (pending) yield pending
}
export function prepareJson(message: Extract<HostMessage, { type: 'result' | 'event' }>, limits: Limits): { bytes: number; fragments(): Generator<JsonFragment> } {
  const value = validateJson(message)
  const width = Math.min(16384, Math.floor((limits.jsonBytes - 1024) / 6))
  if (width < 2) throw new ProtocolError('LIMIT_EXCEEDED')
  let bytes = 0, parts = 0
  for (const data of encodedParts(value, width)) {
    bytes += jsonBytes(data); parts++
    if (bytes > MAX_LOGICAL_JSON_BYTES || parts > MAX_JSON_PARTS) throw new ProtocolError('LIMIT_EXCEEDED')
  }
  return { bytes, *fragments() {
    if (parts < 2) throw new ProtocolError('INVALID_MESSAGE')
    let index = 0
    for (const data of encodedParts(value, width)) {
      const part: JsonFragment = { v: 1, type: 'json.fragment', id: message.id, fence: message.fence, logicalType: message.type, index: index++, parts, bytes, data }
      parseHost(JSON.stringify(part), limits); yield part
    }
  } }
}

/** The ordinary schema is checked again after assembly; fragments never grant a new RPC. */
export function* fragmentJson(message: Extract<HostMessage, { type: 'result' | 'event' }>, text: string, limits: Limits): Generator<JsonFragment> {
  checkJsonLength(text, MAX_LOGICAL_JSON_BYTES)
  const bytes = jsonBytes(text)
  // A UTF-16 unit can require six bytes when JSON-escaped. Reserve the envelope too.
  const width = Math.min(16384, Math.floor((limits.jsonBytes - 1024) / 6))
  if (width < 2) throw new ProtocolError('LIMIT_EXCEEDED')
  const endOf = (start: number) => {
    let end = Math.min(text.length, start + width)
    const last = text.charCodeAt(end - 1), next = text.charCodeAt(end)
    if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--
    return end
  }
  let parts = 0
  for (let start = 0; start < text.length; start = endOf(start)) parts++
  if (parts < 2 || parts > MAX_JSON_PARTS) throw new ProtocolError('LIMIT_EXCEEDED')
  for (let index = 0, start = 0; index < parts; index++) {
    const end = endOf(start)
    const part: JsonFragment = { v: 1, type: 'json.fragment', id: message.id, fence: message.fence, logicalType: message.type, index, parts, bytes, data: text.slice(start, end) }
    start = end
    parseHost(JSON.stringify(part), limits)
    yield part
  }
}

/** Metadata-only ordering checks also run at Relay and on cancelled operations. */
export class JsonFragmentSequence {
  private group?: { logicalType: 'result' | 'event'; parts: number; bytes: number; index: number; received: number }
  get active(): boolean { return this.group !== undefined }
  clear(): void { this.group = undefined }
  accept(part: JsonFragment): boolean {
    if (!this.group) {
      if (part.index !== 0) throw new ProtocolError('INVALID_MESSAGE')
      this.group = { logicalType: part.logicalType, parts: part.parts, bytes: part.bytes, index: 0, received: 0 }
    }
    const group = this.group
    if (part.logicalType !== group.logicalType || part.parts !== group.parts || part.bytes !== group.bytes || part.index !== group.index) throw new ProtocolError('INVALID_MESSAGE')
    group.received += jsonBytes(part.data); group.index++
    if (group.received > group.bytes) throw new ProtocolError('LIMIT_EXCEEDED')
    const done = group.index === group.parts
    if (done) {
      if (group.received !== group.bytes) throw new ProtocolError('INVALID_MESSAGE')
      this.group = undefined
    }
    return done
  }
}

export function assembledHost(text: string, part: JsonFragment, limits: Limits): Extract<HostMessage, { type: 'result' | 'event' }> {
  const message = parseHost(text, { ...limits, jsonBytes: MAX_LOGICAL_JSON_BYTES })
  if ((message.type !== 'result' && message.type !== 'event') || message.type !== part.logicalType || message.id !== part.id
    || message.fence.instanceId !== part.fence.instanceId || message.fence.runtimeId !== part.fence.runtimeId
    || message.fence.controlId !== part.fence.controlId || message.fence.authEpoch !== part.fence.authEpoch) throw new ProtocolError('INVALID_MESSAGE')
  return message
}
