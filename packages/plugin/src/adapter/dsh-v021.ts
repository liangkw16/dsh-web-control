import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ImageMediaType, FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { PromptContentPart, SessionCreateRequest, SessionPageRequest, SessionPromptRequest, SessionRequestId, SessionHistoryRecord, SessionFollowFrame } from '@deepseek-ai/dsh-api-session-controller'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { FileUploadReceiptId, PromptFileBinding } from '@deepseek-ai/dsh-client-file-upload'
import type {} from '@deepseek-ai/dsh-api-gateway'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session-projection'
import { DEFAULT_LIMITS, MAX_LOGICAL_JSON_BYTES, ProtocolError, validateJson, type Command, type Json } from '../../../protocol/src/index.ts'
import { opaqueId, SessionScope } from './scope.ts'
import { StopTokens } from './stop-tokens.ts'
import { supportsWorkspaceManagement } from './ui-rc2.ts'
import type { SessionAdapter } from './types.ts'

type PromptCommand = Extract<Command, { op: 'session.prompt' }>
export interface DshSessionAdapterOptions { reserve: (bytes: number) => () => void }
// Standalone adapter fixtures have no aggregate; production always supplies its Host budget.
const standaloneOptions: DshSessionAdapterOptions = { reserve: () => () => {} }
interface SharedState { tokens: StopTokens; attempts: Map<string, Promise<Json>> }
const HISTORY_PAGE_MESSAGES = 64
const HISTORY_PAGE_LIMIT = 64
// Reserve the authenticated event/result envelope; the 256 KiB wire cap is unchanged.
export const SESSION_JSON_BYTES = DEFAULT_LIMITS.jsonBytes - 2048

const unbound = () => { throw new ProtocolError('STALE_CONTROL', 'A bound admission guard is required') }
/** Filename retained from the planned adapter; certified only against public 0.2.0-rc.2. */
export class DshSessionAdapter implements SessionAdapter {
  private readonly scope: SessionScope
  private readonly tokens: StopTokens
  private readonly state: SharedState
  constructor(private readonly ctx: Context, private readonly admission: () => void = unbound, private readonly options: DshSessionAdapterOptions = standaloneOptions, state?: SharedState) {
    this.scope = new SessionScope(() => ctx.workspaceRegistry.list().map(workspace => ({ workspaceId: workspace.id, sessionIds: workspace.sessionIds })), undefined, supportsWorkspaceManagement(ctx) ? 'host-profile' : 'registered-workspaces')
    this.tokens = state?.tokens ?? new StopTokens(id => {
      const agent = ctx.agents.get(SessionId(opaqueId(id)))
      if (!agent) return null
      const seq = ctx.sessionProjections.stateOf(agent.session, 'turnBoundary')?.openTurnStartSeq
      return typeof seq === 'number' && Number.isSafeInteger(seq) && seq >= 0 ? { agent, turnStartSeq: seq } : null
    }, id => {
      try { return validateJson(ctx.sessionController.cancel({ sessionId: SessionId(id) })) }
      catch (error) { throw mappedFailure(error) }
    })
    this.state = state ?? { tokens: this.tokens, attempts: new Map() }
  }
  withAdmission(check: () => void): SessionAdapter { return new DshSessionAdapter(this.ctx, check, this.options, this.state) }
  async assertSession(id: string): Promise<void> { this.scope.assertSession(id) }
  private checkSession(id: string): void { this.admission(); this.scope.assertSession(id) }
  async list(workspaceId: string, cursor?: string): Promise<Json> {
    this.admission(); this.scope.assertWorkspace(workspaceId)
    const value = validateJson(await this.ctx.typertGateway.invoke({ namespace: 'session', method: 'list', args: { _request: cursor === undefined ? {} : { cursor: opaqueId(cursor) } } }))
    this.admission(); this.scope.assertWorkspace(workspaceId)
    if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.items)) throw new ProtocolError('RESULT_UNCERTAIN')
    const items = value.items.filter(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.sessionId !== 'string') throw new ProtocolError('RESULT_UNCERTAIN')
      try { this.scope.assertSession(item.sessionId, workspaceId); return true } catch (error) {
        if (error instanceof ProtocolError && error.code === 'OUT_OF_SCOPE') return false
        throw error
      }
    })
    return { items }
  }
  async create(workspaceId: string, sessionId: string): Promise<Json> {
    const request: SessionCreateRequest = { workspaceId: brandString<WorkspaceId>(opaqueId(workspaceId)), sessionId: SessionId(opaqueId(sessionId)) }
    this.admission(); this.scope.assertCreate(workspaceId, sessionId)
    const value = await this.mutate('create', request)
    this.admission(); this.scope.assertSession(sessionId, workspaceId)
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.sessionId !== sessionId) throw new ProtocolError('RESULT_UNCERTAIN')
    return value
  }
  async prompt(command: PromptCommand, signal: AbortSignal): Promise<Json> {
    this.checkSession(command.sessionId)
    opaqueId(command.requestId)
    const key = JSON.stringify([command.sessionId, command.requestId])
    const existing = this.state.attempts.get(key)
    if (existing) {
      try { const result = await existing; this.checkSession(command.sessionId); return result }
      catch (error) {
        this.checkSession(command.sessionId)
        if (!command.reconcileOnly) throw error
        if (await this.accepted(command, signal)) return { accepted: true }
        throw new ProtocolError('RESULT_UNCERTAIN')
      }
    }
    if (command.reconcileOnly) {
      if (await this.accepted(command, signal)) return { accepted: true }
      throw new ProtocolError('RESULT_UNCERTAIN')
    }
    if (this.state.attempts.size >= DEFAULT_LIMITS.calls) throw new ProtocolError('BACKPRESSURE')
    // Publish before starting any awaited lookup/preparation, so facades cannot race.
    const pending = Promise.withResolvers<Json>()
    this.state.attempts.set(key, pending.promise)
    let result: Json
    try {
      result = await this.preparePrompt(command, signal)
      // Native outcome belongs to the shared attempt, not the originating response guard.
      pending.resolve(result)
    } catch (error) { pending.reject(error); throw error }
    finally { this.state.attempts.delete(key); void pending.promise.catch(() => {}) }
    this.checkSession(command.sessionId)
    return result
  }
  private async accepted(command: PromptCommand, signal: AbortSignal): Promise<boolean> {
    this.checkSession(command.sessionId); signal.throwIfAborted()
    const address = { kind: 'session', sessionId: SessionId(command.sessionId) } as const
    let observer: AsyncIterator<SessionFollowFrame> | undefined
    let found = false
    try {
      observer = this.ctx.sessionController.follow({ address, maxMessages: HISTORY_PAGE_MESSAGES }, signal)[Symbol.asyncIterator]()
      const first = await observer.next()
      this.checkSession(command.sessionId)
      if (first.done || first.value.type !== 'snapshot') throw new ProtocolError('RESULT_UNCERTAIN')
      const snapshot = first.value
      found = acceptedRecords(snapshot.records, command.requestId) || acceptedInbox(snapshot.projections.values.inbox, command.requestId)
      const agent = this.ctx.agents.get(address.sessionId)
      if (agent) found ||= [...agent.inbox.nextTurn, ...agent.inbox.nextStep].some(message => requestSource(message, command.requestId))
      let records = snapshot.records; let more = snapshot.hasMore
      let beforeSeq = snapshot.cursor + 1
      for (let page = 0; !found && more; page++) {
        if (page >= HISTORY_PAGE_LIMIT || records.length === 0) throw new ProtocolError('RESULT_UNCERTAIN', 'Admission history exceeds the bounded reconciliation window')
        const nextSeq = records[0].event.seq
        if (!Number.isSafeInteger(nextSeq) || nextSeq < 0 || nextSeq >= beforeSeq) throw new ProtocolError('RESULT_UNCERTAIN')
        beforeSeq = nextSeq
        this.checkSession(command.sessionId); signal.throwIfAborted()
        const earlier = await this.ctx.sessionController.page({ address, throughSeq: snapshot.cursor, beforeSeq, maxMessages: HISTORY_PAGE_MESSAGES }, signal)
        this.checkSession(command.sessionId)
        records = earlier.records; more = earlier.hasMore
        found = acceptedRecords(records, command.requestId)
      }
    } catch (error) { throw mappedFailure(error) }
    finally {
      try { await observer?.return?.() } catch (error) { throw mappedFailure(error) }
    }
    this.checkSession(command.sessionId)
    return found
  }
  private async preparePrompt(command: PromptCommand, signal: AbortSignal): Promise<Json> {
    if (await this.accepted(command, signal)) return { accepted: true }
    this.checkSession(command.sessionId); signal.throwIfAborted()
    const content: PromptContentPart[] = []
    const retained: (() => void)[] = []
    let imageCount = 0
    try {
      const bindings: { agent: Agent; receiptId: FileUploadReceiptId; attachmentId: string }[] = []
      let total = 0
      for (const part of command.content) {
        if (part.kind === 'text') { content.push({ type: 'text', text: part.text }); continue }
        const receiptId = brandString<FileUploadReceiptId>(opaqueId(part.receiptId))
        if (!part.mediaType.startsWith('image/')) { content.push({ type: 'file', receiptId }); continue }
        const agent = this.ctx.agents.get(SessionId(command.sessionId))
        if (!agent) throw new ProtocolError('OUT_OF_SCOPE')
        const file = this.receipt(agent, receiptId)
        if (!file) throw new ProtocolError('OUT_OF_SCOPE')
        const limits = this.ctx.attachments.imageLimits
        const mediaType = limits.mediaTypes.find(type => type === part.mediaType)
        if (!mediaType) throw new ProtocolError('INVALID_MESSAGE', 'Unsupported image media type')
        if (!Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > limits.maxImageBytes || imageCount >= limits.maxImagesPerMessage || total + file.bytes > limits.maxMessageImageBytes) throw new ProtocolError('LIMIT_EXCEEDED')
        total += file.bytes
        content.push(await this.imageContent(command, signal, agent, receiptId, file, mediaType, retained))
        this.checkSession(command.sessionId); signal.throwIfAborted()
        bindings.push({ agent, receiptId, attachmentId: file.attachmentId })
        imageCount++
      }
      const request: SessionPromptRequest = { sessionId: SessionId(opaqueId(command.sessionId)), requestId: brandString<SessionRequestId>(opaqueId(command.requestId)), mode: command.mode, content, ...(command.clientTimeZone === undefined ? {} : { clientTimeZone: command.clientTimeZone }) }
      const check = () => {
        this.checkSession(command.sessionId); signal.throwIfAborted()
        for (const item of bindings) {
          if (this.ctx.agents.get(request.sessionId) !== item.agent || this.receipt(item.agent, item.receiptId)?.attachmentId !== item.attachmentId) throw new ProtocolError('OUT_OF_SCOPE')
        }
      }
      let binding: PromptFileBinding | undefined
      let dispatched = false
      let committed = false
      try {
        check()
        if (bindings.length) {
          try { binding = this.ctx.fileUploads.bindPrompt(bindings[0].agent, [...new Set(bindings.map(item => item.receiptId))], command.requestId) }
          catch (error) { throw mappedFailure(error) }
        }
        // Binding and invocation are synchronous admission; recheck any service callbacks.
        check()
        dispatched = true
        // The Host's prompt signal is admission-only; it never owns the accepted Agent loop.
        const result = await this.mutate('prompt', request, signal)
        if (!result || typeof result !== 'object' || Array.isArray(result) || result.accepted !== true) throw new ProtocolError('RESULT_UNCERTAIN')
        binding?.commit(); committed = true
        return result
      } catch (error) {
        if (!dispatched) throw error
        const failure = mappedFailure(error)
        // Preserve an already-created binding when dispatched intake is ambiguous.
        // Finalization is ownership bookkeeping and cannot authorize a new command.
        if (dispatched && !committed && failure instanceof ProtocolError && failure.code === 'RESULT_UNCERTAIN') binding?.commit()
        throw failure
      } finally { binding?.[Symbol.dispose]() }
    } finally { for (const release of retained) release() }
  }
  private async imageContent(command: PromptCommand, signal: AbortSignal, agent: Agent, receiptId: FileUploadReceiptId, file: FileAttachmentRef, mediaType: ImageMediaType, retained: (() => void)[]): Promise<PromptContentPart> {
    const chunks: Buffer[] = []; const releases: (() => void)[] = []
    let bytes = 0; let data: Buffer | undefined; let releaseData: (() => void) | undefined
    try {
      try {
        for await (const chunk of this.ctx.attachments.readFileStream(file, signal)) {
          this.checkSession(command.sessionId); signal.throwIfAborted()
          bytes += chunk.byteLength
          if (bytes > file.bytes) throw new ProtocolError('LIMIT_EXCEEDED')
          if (!chunk.byteLength) continue
          releases.push(this.options.reserve(chunk.byteLength + 128))
          // Exact backing allocation avoids retaining an uncharged pooled slab.
          const copy = Buffer.allocUnsafeSlow(chunk.byteLength); copy.set(chunk); chunks.push(copy)
        }
      } catch (error) { throw mappedFailure(error) }
      this.checkSession(command.sessionId); signal.throwIfAborted()
      if (bytes !== file.bytes || this.ctx.agents.get(SessionId(command.sessionId)) !== agent || this.receipt(agent, receiptId)?.attachmentId !== file.attachmentId) throw new ProtocolError('OUT_OF_SCOPE')
      releaseData = this.options.reserve(bytes + 128)
      data = Buffer.allocUnsafeSlow(bytes)
      let offset = 0
      for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length }
      // Concatenation overlaps the source copies until their references are dropped.
      chunks.length = 0; for (const release of releases.splice(0)) release()
      await this.ctx.attachments.validateImage({ mediaType, data, name: file.name })
      this.checkSession(command.sessionId); signal.throwIfAborted()
      // Conservatively account UTF-16 storage, including overlap with decoded data.
      retained.push(this.options.reserve(2 * 4 * Math.ceil(bytes / 3) + 128))
      return { type: 'image', mediaType, data: data.toString('base64'), name: file.name }
    } finally {
      data = undefined; chunks.length = 0
      releaseData?.(); for (const release of releases) release()
    }
  }
  async page(command: Extract<Command, { op: 'session.page' }>, signal: AbortSignal, jsonBytes = DEFAULT_LIMITS.jsonBytes): Promise<Json> {
    const request: SessionPageRequest = { address: { kind: 'session', sessionId: SessionId(opaqueId(command.sessionId)) }, throughSeq: command.throughSeq, maxMessages: command.maxMessages, ...(command.beforeSeq === undefined ? {} : { beforeSeq: command.beforeSeq }) }
    let maxMessages = Math.min(command.maxMessages, HISTORY_PAGE_MESSAGES)
    while (true) {
      this.checkSession(command.sessionId); signal.throwIfAborted()
      const native = await this.ctx.typertGateway.invoke({ namespace: 'session', method: 'page', args: { request: { ...request, maxMessages, ...(command.turnWindow ? { turnWindow: { ...command.turnWindow, minMessages: Math.min(command.turnWindow.minMessages, maxMessages) } } : {}) } }, signal })
      this.checkSession(command.sessionId); signal.throwIfAborted()
      try { return publicJson(native, jsonBytes - 2048) }
      catch (error) {
        if (!(error instanceof ProtocolError) || error.code !== 'LIMIT_EXCEEDED' || maxMessages === 1) throw error
        maxMessages = Math.max(1, Math.floor(maxMessages / 2))
      }
    }
  }
  currentStopToken(id: string): string | null { this.scope.assertSession(id); return this.tokens.current(id) }
  stop(id: string, token: string): Json {
    // No awaits between Fence + live scope + exact Agent/turn comparison and public cancel.
    this.checkSession(id)
    return this.tokens.stop(id, token)
  }
  private receipt(agent: Agent, receiptId: FileUploadReceiptId): FileAttachmentRef | undefined {
    try { return this.ctx.fileUploads.resolve(agent, receiptId) } catch (error) { throw mappedFailure(error) }
  }
  private async mutate(method: 'create' | 'prompt', request: SessionCreateRequest | SessionPromptRequest, signal?: AbortSignal): Promise<Json> {
    try { return validateJson(await this.ctx.typertGateway.invoke({ namespace: 'session', method, args: { request }, ...(signal ? { signal } : {}) })) }
    catch (error) { throw mappedFailure(error) }
  }
}
function mappedFailure(error: unknown): Error {
  if (error instanceof ProtocolError) return error
  if (error && typeof error === 'object' && 'code' in error && error.code === 'session/writer-held') return new ProtocolError('WRITER_HELD')
  return new ProtocolError('RESULT_UNCERTAIN')
}

function requestSource(message: unknown, requestId: string): boolean {
  if (!message || typeof message !== 'object' || !('source' in message)) return false
  const source = message.source
  return !!source && typeof source === 'object' && 'kind' in source && source.kind === 'user' && 'rpcId' in source && source.rpcId === requestId
}
function acceptedRecords(records: readonly SessionHistoryRecord[], requestId: string): boolean {
  return records.some(({ event }) => {
    if (event.type === 'user/message') return requestSource(event.data, requestId)
    const data = event.data
    return event.type === 'agent/inbox/spliced' && !!data && typeof data === 'object' && 'inserted' in data && Array.isArray(data.inserted) && data.inserted.some(message => requestSource(message, requestId))
  })
}
function acceptedInbox(inbox: unknown, requestId: string): boolean {
  return !!inbox && typeof inbox === 'object' && ['next-turn', 'next-step'].some(key => {
    if (!(key in inbox)) return false
    const value = Reflect.get(inbox, key)
    return Array.isArray(value) && value.some(message => requestSource(message, requestId))
  })
}

/** Public rc.2 envelope acceptance. Event payloads/projection values are owner-defined JSON. */
export function validateFollowFrame(value: unknown, byteLimit = DEFAULT_LIMITS.jsonBytes): Json {
  const frame = jsonObject(publicJson(value, byteLimit))
  if (frame.type === 'snapshot') {
    fields(frame, ['type', 'header', 'cursor', 'records', 'hasMore', 'projections', 'assistantStream'])
    const header = jsonObject(frame.header)
    fields(header, ['version', 'id', 'createdAt', 'cwd', 'parentSession', 'isSeeded', 'origin', 'delegationDepth', 'agentPreset'])
    integer(header.version); text(header.id); integer(header.createdAt); boolean(header.isSeeded)
    for (const key of ['cwd', 'parentSession', 'agentPreset']) if (header[key] !== undefined) text(header[key])
    if (header.origin !== undefined && header.origin !== 'subagent') invalid()
    if (header.delegationDepth !== undefined) integer(header.delegationDepth)
    integer(frame.cursor, -1); boolean(frame.hasMore); projectionBaseline(frame.projections)
    if (!Array.isArray(frame.records)) invalid()
    for (const record of frame.records) eventEntry(record)
    if (frame.assistantStream !== undefined) {
      const baseline = jsonObject(frame.assistantStream); fields(baseline, ['revision', 'activeAttempt']); integer(baseline.revision)
      if (baseline.activeAttempt !== undefined) {
        const attempt = jsonObject(baseline.activeAttempt); fields(attempt, ['attemptId', 'startedAfterSeq', 'turn', 'step', 'nextIndex', 'stream'])
        text(attempt.attemptId); integer(attempt.startedAfterSeq, -1); integer(attempt.turn); integer(attempt.step); integer(attempt.nextIndex)
        if (!Array.isArray(attempt.stream)) invalid()
      }
    }
  } else if (frame.type === 'event') eventEntry(frame)
  else if (frame.type === 'assistant-stream') {
    fields(frame, ['type', 'frame']); const assistant = jsonObject(frame.frame)
    text(assistant.attemptId); integer(assistant.revision)
    if (assistant.type === 'start') {
      fields(assistant, ['type', 'attemptId', 'revision', 'startedAfterSeq', 'turn', 'step']); integer(assistant.startedAfterSeq, -1); integer(assistant.turn); integer(assistant.step)
    } else if (assistant.type === 'chunk') {
      fields(assistant, ['type', 'attemptId', 'revision', 'index', 'time', 'chunk']); integer(assistant.index); integer(assistant.time)
      if (!Object.hasOwn(assistant, 'chunk')) invalid()
    } else if (assistant.type === 'end') {
      fields(assistant, ['type', 'attemptId', 'revision', 'index', 'outcome']); integer(assistant.index)
      const outcome = jsonObject(assistant.outcome)
      if (outcome.kind === 'abandoned') fields(outcome, ['kind'])
      else if (outcome.kind === 'committed') { fields(outcome, ['kind', 'eventType', 'seq']); integer(outcome.seq); if (outcome.eventType !== 'assistant/message' && outcome.eventType !== 'assistant/attempt') invalid() }
      else invalid()
    } else invalid()
  } else invalid()
  return frame
}
export function jsonObject(value: Json | undefined): { [key: string]: Json } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalid()
  return value
}
export function fields(value: { [key: string]: Json }, allowed: readonly string[]): void { if (Object.keys(value).some(key => !allowed.includes(key))) invalid() }
export function integer(value: Json | undefined, min = 0): void { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || Object.is(value, -0)) invalid() }
export function text(value: Json | undefined): asserts value is string { if (typeof value !== 'string' || !value.length) invalid() }
function boolean(value: Json | undefined): void { if (typeof value !== 'boolean') invalid() }
export function invalid(): never { throw new ProtocolError('INVALID_MESSAGE') }
export function projectionBaseline(value: Json | undefined): void { const baseline = jsonObject(value); fields(baseline, ['asOfSeq', 'values']); integer(baseline.asOfSeq, -1); jsonObject(baseline.values) }
function eventEntry(value: Json): void {
  const record = jsonObject(value); fields(record, ['type', 'event']); if (record.type !== 'event') invalid()
  const event = jsonObject(record.event); fields(event, ['type', 'seq', 'time', 'data', 'ignorable', 'surfaceOp', 'sourceEventSeqs']); text(event.type); integer(event.seq); integer(event.time, Number.MIN_SAFE_INTEGER)
  if (!Object.hasOwn(event, 'data') || (event.ignorable !== undefined && event.ignorable !== true)) invalid()
  if (event.sourceEventSeqs !== undefined && event.ignorable !== true) { if (!Array.isArray(event.sourceEventSeqs)) invalid(); for (const seq of event.sourceEventSeqs) { integer(seq); if (typeof seq !== 'number' || typeof event.seq !== 'number' || seq >= event.seq) invalid() } }
  if (event.surfaceOp !== undefined && event.surfaceOp !== 'append' && event.ignorable !== true) { const op = jsonObject(event.surfaceOp); fields(op, ['op', 'startSeq', 'endSeq']); if (op.op !== 'replace') invalid(); integer(op.startSeq); integer(op.endSeq); if (typeof op.startSeq !== 'number' || typeof op.endSeq !== 'number' || typeof event.seq !== 'number' || op.startSeq > op.endSeq || op.endSeq >= event.seq) invalid() }
}

/** The public in-process Gateway projects requests into null-prototype records.
 * Copy own data descriptors only, never getters/toJSON or arbitrary instances.
 */
export function publicJson(value: unknown, byteLimit = DEFAULT_LIMITS.jsonBytes): Json {
  if (!Number.isSafeInteger(byteLimit) || byteLimit < 1 || byteLimit > MAX_LOGICAL_JSON_BYTES) invalid()
  let remaining = byteLimit
  const ancestors = new WeakSet<object>()
  const debit = (bytes: number) => { remaining -= bytes; if (remaining < 0) throw new ProtocolError('LIMIT_EXCEEDED') }
  const primitive = (item: unknown) => {
    if (typeof item === 'string' && item.length > remaining) throw new ProtocolError('LIMIT_EXCEEDED')
    if (item !== null && typeof item !== 'string' && typeof item !== 'number' && typeof item !== 'boolean') invalid()
    if (typeof item === 'number' && !Number.isFinite(item)) invalid()
    debit(Buffer.byteLength(JSON.stringify(item))); return item
  }
  const copy = (item: unknown, depth: number): unknown => {
    if (depth > 64) invalid()
    if (!item || typeof item !== 'object') return primitive(item)
    if (ancestors.has(item)) invalid()
    ancestors.add(item)
    try {
    if (Array.isArray(item)) {
      debit(2 + Math.max(0, item.length - 1))
      if (Object.getPrototypeOf(item) !== Array.prototype || Reflect.ownKeys(item).length !== item.length + 1) invalid()
      return Array.from({ length: item.length }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(index))
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) invalid()
        return copy(descriptor.value, depth + 1)
      })
    }
    const prototype = Object.getPrototypeOf(item)
    if (prototype !== Object.prototype && prototype !== null) invalid()
    debit(2)
    let count = 0
    return Object.fromEntries(Reflect.ownKeys(item).map(key => {
      if (typeof key !== 'string') invalid()
      primitive(key); debit(1 + (count++ ? 1 : 0))
      const descriptor = Object.getOwnPropertyDescriptor(item, key)
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) invalid()
      return [key, copy(descriptor.value, depth + 1)]
    }))
    } finally { ancestors.delete(item) }
  }
  return validateJson(copy(value, 0))
}
