import { DEFAULT_LIMITS, ProtocolError, type ContentPart, type Json } from '../../../protocol/src/index.ts'
import type { BrowserTransport } from '../transport.ts'
import { argsOf, fields, object, text } from './read-routes.ts'
export class NativeUploads {
  private readonly life = new AbortController()
  private readonly pending = new Set<Promise<Json>>()
  private readonly receipts = new Map<string, { sessionId: string; part: ContentPart }>()
  constructor(private readonly transport: Pick<BrowserTransport, 'upload'>, private readonly action: (sessionId: string) => { signal: AbortSignal }) {}
  fetch = async (input: string | URL, init: RequestInit): Promise<Response> => {
    const path = String(input)
    if (!/^\/?api\/session\/uploadFileBinary\?/.test(path) || init.method !== 'POST') throw new ProtocolError('PROTOCOL_UNSUPPORTED')
    const url = new URL(path.startsWith('/') ? path : '/' + path, 'https://native.invalid')
    if (url.pathname !== '/api/session/uploadFileBinary' || url.hash || [...url.searchParams.keys()].some(k => k !== 'sessionId' && k !== 'name') || url.searchParams.getAll('sessionId').length !== 1 || url.searchParams.getAll('name').length > 1) throw new ProtocolError('INVALID_MESSAGE')
    const sessionId = text(url.searchParams.get('sessionId')), name = url.searchParams.get('name') ?? 'upload.bin'
    if (!(init.body instanceof Blob) && !(init.body instanceof ReadableStream)) throw new ProtocolError('INVALID_MESSAGE')
    const value = await this.upload(sessionId, init.body, name, init.signal ?? undefined)
    return Response.json({ ok: true, value })
  }
  /** Uint8Array fallback of the unchanged FileUploadRuntime. */
  rpc(payload: unknown, caller: AbortSignal): Promise<Json> {
    const args = argsOf('/api', payload, 48 * 1024 * 1024); fields(args, ['agentId', 'request'])
    const request = object(args.request); fields(request, ['data'], ['name'])
    const sessionId = text(args.agentId), bytes = decode(request.data, DEFAULT_LIMITS.fileBytes)
    return this.upload(sessionId, new Blob([bytes]), request.name === undefined ? 'upload.bin' : text(request.name), caller)
  }
  release(content: ContentPart[]): void { for (const part of content) if (part.kind === 'upload') this.receipts.delete(part.receiptId) }
  upload(sessionId: string, body: Blob | ReadableStream<Uint8Array>, name: string, caller?: AbortSignal): Promise<Json> {
    const action = this.action(sessionId), signal = AbortSignal.any([action.signal, this.life.signal, ...(caller ? [caller] : [])])
    if (this.pending.size >= DEFAULT_LIMITS.uploads || this.receipts.size >= 256) return Promise.reject(new ProtocolError('BACKPRESSURE'))
    const pending = (async () => {
      const blob = body instanceof Blob ? body : await this.collect(body, signal)
      signal.throwIfAborted(); if (blob.size > DEFAULT_LIMITS.fileBytes) throw new ProtocolError('LIMIT_EXCEEDED')
      const file = new File([blob], name, { type: blob.type || 'application/octet-stream' })
      const value = object(await this.transport.upload(sessionId, file, signal)); signal.throwIfAborted()
      fields(value, ['receiptId', 'file']); const stored = object(value.file); fields(stored, ['attachmentId', 'name', 'bytes'])
      if (stored.bytes !== file.size) throw new ProtocolError('RESULT_UNCERTAIN')
      text(stored.attachmentId); const receiptId = text(value.receiptId), part: ContentPart = { kind: 'upload', receiptId, name: text(stored.name), mediaType: file.type }
      this.receipts.set(receiptId, { sessionId, part }); return value
    })()
    this.pending.add(pending); void pending.finally(() => this.pending.delete(pending)).catch(() => {}); return pending
  }
  async content(sessionId: string, content: Json[], signal: AbortSignal): Promise<ContentPart[]> {
    const result: ContentPart[] = []; let imageBytes = 0, images = 0
    for (const item of content) {
      signal.throwIfAborted(); const part = object(item)
      if (part.type === 'text') { fields(part, ['type', 'text']); if (typeof part.text !== 'string') throw new ProtocolError('INVALID_MESSAGE'); result.push({ kind: 'text', text: part.text }); continue }
      let receiptId: string
      if (part.type === 'image') {
        fields(part, ['type', 'mediaType', 'data'], ['name'])
        if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(String(part.mediaType)) || typeof part.data !== 'string' || part.data.length > 4 * Math.ceil(20 * 1024 * 1024 / 3) || ++images > 20 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(part.data)) throw new ProtocolError('INVALID_MESSAGE')
        const decoded = atob(part.data); imageBytes += decoded.length
        if (!decoded.length || imageBytes > DEFAULT_LIMITS.fileBytes || btoa(decoded) !== part.data) throw new ProtocolError('LIMIT_EXCEEDED')
        const bytes = Uint8Array.from(decoded, c => c.charCodeAt(0)), name = part.name === undefined ? 'image.' + String(part.mediaType).slice(6) : text(part.name)
        const uploaded = object(await this.upload(sessionId, new Blob([bytes], { type: String(part.mediaType) }), name, signal)); receiptId = text(uploaded.receiptId)
      } else if (part.type === 'file') { fields(part, ['type', 'receiptId']); receiptId = text(part.receiptId) }
      else throw new ProtocolError('PROTOCOL_UNSUPPORTED')
      const receipt = this.receipts.get(receiptId)
      if (!receipt || receipt.sessionId !== sessionId) throw new ProtocolError('OUT_OF_SCOPE')
      result.push(receipt.part)
    }
    return result
  }
  private async collect(body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<Blob> {
    const reader = body.getReader(), parts: BlobPart[] = []; let size = 0
    const abort = () => { void reader.cancel(signal.reason).catch(() => {}) }
    signal.addEventListener('abort', abort, { once: true })
    try {
      if (signal.aborted) abort()
      while (true) {
        signal.throwIfAborted(); const next = await reader.read(); signal.throwIfAborted(); if (next.done) return new Blob(parts)
        if (!(next.value instanceof Uint8Array)) throw new ProtocolError('INVALID_MESSAGE')
        size += next.value.byteLength; if (size > DEFAULT_LIMITS.fileBytes) throw new ProtocolError('LIMIT_EXCEEDED')
        parts.push(new Uint8Array(next.value).buffer)
      }
    } finally { signal.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); reader.releaseLock() }
  }
  async dispose(): Promise<void> { this.life.abort(); await Promise.allSettled(this.pending); this.receipts.clear() }
}

function decode(value: Json | undefined, max: number): Uint8Array<ArrayBuffer> {
  if (typeof value !== 'string' || value.length > 4 * Math.ceil(max / 3) || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new ProtocolError('INVALID_MESSAGE')
  const decoded = atob(value)
  if (decoded.length > max || btoa(decoded) !== value) throw new ProtocolError('LIMIT_EXCEEDED')
  return Uint8Array.from(decoded, c => c.charCodeAt(0))
}
