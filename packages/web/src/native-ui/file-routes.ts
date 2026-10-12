import type { ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection/client'
import { CURRENT_FILE_TEXT_BYTES, CURRENT_FILE_TEXT_LINES, DEFAULT_LIMITS, MAX_READ_BYTES, ProtocolError, integer, parseCurrentFileStat, parseCurrentFileText, type CurrentFileFailureCode } from '../../../protocol/src/index.ts'
import type { BrowserTransport } from '../transport.ts'
import { argsOf, fields, object, rpcFailure, text } from './read-routes.ts'

function number(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number { integer(value, min, max); return value }
export const FILE_ENDPOINTS = new Set(['workspaceFiles/stat', 'workspaceFiles/read', 'workspaceFiles/readBytes'])
function nativeFailure(code: CurrentFileFailureCode, path: string) {
  const codes = { missing: 'not-found', outside: 'outside-workspace', 'not-regular': 'not-regular-file', 'too-large': 'too-large', 'not-text': 'not-text' } as const
  if (code === 'changed' || code === 'unsupported') return rpcFailure(new ProtocolError(code === 'changed' ? 'RESULT_UNCERTAIN' : 'PROTOCOL_UNSUPPORTED'))
  return { ok: false as const, error: { code: `workspace-file/${codes[code]}`, message: `workspace-file/${codes[code]}`, details: { path, ...(code === 'not-regular' ? { kind: 'other' } : {}), ...(code === 'too-large' ? { limit: CURRENT_FILE_TEXT_BYTES } : {}) } } }
}
/** Finite native filesystem DTO bridge. DSH still owns resource caching, tab
 * state, renderer selection and document dependencies. */
export class NativeFileRoutes {
  private lifetime = new AbortController()
  constructor(private readonly transport: Pick<BrowserTransport, 'call' | 'watch' | 'readFileRange'>, private readonly enabled: boolean) {}
  async call(channel: string, endpoint: string, payload: unknown, caller: AbortSignal): Promise<ConnectionRpcResult<unknown>> {
    const signal = AbortSignal.any([caller, this.lifetime.signal])
    try {
      if (!this.enabled || !FILE_ENDPOINTS.has(endpoint)) throw new ProtocolError('PROTOCOL_UNSUPPORTED')
      const args = argsOf(channel, payload)
      fields(args, ['workspaceFileScopeId', 'path', ...(endpoint.endsWith('/readBytes') ? ['options'] : endpoint.endsWith('/read') ? ['range'] : [])])
      const sessionId = text(args.workspaceFileScopeId), path = text(args.path)
      let baseFile: string | undefined, offset = 0, length: number | undefined, lineLimit = CURRENT_FILE_TEXT_LINES
      if (endpoint === 'workspaceFiles/readBytes') {
        const options = object(args.options); fields(options, [], ['range', 'baseFile'])
        if (options.baseFile !== undefined) baseFile = text(options.baseFile)
        if (options.range !== undefined) { const range = object(options.range); fields(range, [], ['offset', 'length']); offset = range.offset === undefined ? 0 : number(range.offset); length = range.length === undefined ? MAX_READ_BYTES : number(range.length, 0, MAX_READ_BYTES) }
      } else if (endpoint === 'workspaceFiles/read') {
        const range = object(args.range); fields(range, [], ['offset', 'limit']); offset = range.offset === undefined ? 1 : number(range.offset, 1); lineLimit = range.limit === undefined ? CURRENT_FILE_TEXT_LINES : number(range.limit, 1, CURRENT_FILE_TEXT_LINES)
      }
      signal.throwIfAborted()
      const stat = parseCurrentFileStat(await this.transport.call({ op: 'file.stat', sessionId, path, ...(baseFile ? { baseFile } : {}) }, signal)); signal.throwIfAborted()
      if (!stat.ok) return nativeFailure(stat.code, path)
      const { relativePath, ...nativeStat } = stat.value
      if (endpoint === 'workspaceFiles/stat') return { ok: true, value: nativeStat }
      if (endpoint === 'workspaceFiles/read') {
        const page = parseCurrentFileText(await this.transport.call({ op: 'file.text', sessionId, path: relativePath, version: stat.value.version, offset, limit: lineLimit }, signal)); signal.throwIfAborted()
        if (!page.ok) return nativeFailure(page.code, path)
        if (page.value.version !== stat.value.version || page.value.absolutePath !== nativeStat.absolutePath || page.value.bytes !== nativeStat.bytes || page.value.offset !== offset || page.value.lines > lineLimit) throw new ProtocolError('INVALID_MESSAGE')
        return { ok: true, value: page.value }
      }
      const count = Math.max(0, Math.min(length ?? stat.value.bytes, stat.value.bytes - offset))
      if (count > DEFAULT_LIMITS.fileBytes) return nativeFailure('too-large', path)
      const data = new Uint8Array(count)
      let received = 0
      // Even empty windows open a version-checked transfer, rather than trusting
      // a stat from before the current read call.
      do {
        const request = Math.min(MAX_READ_BYTES, count - received)
        const { blob, metadata } = await this.transport.readFileRange({ sessionId, path: relativePath, version: stat.value.version, offset: offset + received, length: request }, signal)
        signal.throwIfAborted()
        if (metadata.offset !== offset + received || metadata.bytes !== request || blob.size !== request || metadata.eof !== (offset + received + request >= stat.value.bytes)) throw new ProtocolError('INVALID_MESSAGE')
        const bytes = new Uint8Array(await blob.arrayBuffer()); signal.throwIfAborted()
        data.set(bytes, received); received += bytes.length
      } while (received < count)
      return { ok: true, value: { ...nativeStat, offset, data, eof: offset + count >= stat.value.bytes } }
    } catch (error) { return rpcFailure(error) }
  }
  async *open(channel: string, endpoint: string, payload: unknown, caller: AbortSignal): AsyncIterable<unknown> {
    if (!this.enabled || endpoint !== 'workspaceFiles/changes') throw new ProtocolError('PROTOCOL_UNSUPPORTED')
    const args = argsOf(channel, payload); fields(args, ['workspaceFileScopeId', 'path'])
    const signal = AbortSignal.any([caller, this.lifetime.signal])
    let ready = false
    for await (const value of this.transport.watch({ topic: 'file', sessionId: text(args.workspaceFileScopeId), path: text(args.path) }, signal)) {
      signal.throwIfAborted(); const frame = object(value)
      if (frame.kind === 'ready' && !ready) { fields(frame, ['kind']); ready = true }
      else if (frame.kind === 'change' && ready) {
        fields(frame, ['kind', 'change']); const change = object(frame.change)
        fields(change, ['absolutePath', change.absent === true ? 'absent' : 'version']); text(change.absolutePath)
        if (change.absent !== true) text(change.version)
      } else throw new ProtocolError('INVALID_MESSAGE')
      yield frame
    }
  }
  dispose(): void { this.lifetime.abort() }
}
