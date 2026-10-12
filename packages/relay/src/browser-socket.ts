import { CURRENT_FILES_CAPABILITY } from '@dsh-web-control/protocol'
import { selectUiProfile, type UiRelease } from './ui-profiles.ts'
import {
  ProtocolError,
  JsonFragmentSequence,
  LARGE_JSON_CAPABILITY,
  TransferWindow,
  decodeChunk,
  negotiate,
  parseController,
  parseHandshake,
  parseHost,
  validateDownloadMetadata,
  type ControllerMessage,
  type Fence,
  type SelectedUiProfile,
  type HostMessage,
} from '@dsh-web-control/protocol'
import type { AuthStore } from './auth.ts'
import type { Lease, LeaseTable } from './leases.ts'
import { HANDSHAKE_MS } from './config.ts'
import { fault } from './logging.ts'
import { HostSocket, sameFence } from './host-socket.ts'
import type { Transport } from './transport.ts'
type OperationKind = 'call' | 'watch' | 'upload' | 'download'
interface Operation {
  kind: OperationKind
  state: 'active' | 'retired' | 'completed'
  cancelled: boolean
  dispatched: boolean
  pending: number
  deadline: number
  command?: Extract<ControllerMessage, { type: 'call' }>['command']
  downloadId?: string
  fragments?: JsonFragmentSequence
  fragmentDeadline?: number
  drainAcknowledged?: boolean
}
interface Transfer {
  window: TransferWindow
  deadline: number
  direction: 'upload' | 'download'
  cancelled: boolean
  ended: boolean
}
export class BrowserSocket {
  private state: 'hello' | 'lease' | 'attach' | 'ready' | 'closed' = 'hello'
  private lease?: Lease
  private acknowledged = false
  private uiProfile?: SelectedUiProfile
  private timer: NodeJS.Timeout
  private readonly calls = new Map<
    string,
    {
      command: Extract<ControllerMessage, { type: 'call' }>['command']
      deadline: number
    }
  >()
  private readonly watches = new Set<string>()
  private readonly transfers = new Map<string, Transfer>()
  private readonly uploads = new Map<string, number>()
  private readonly operations = new Map<string, Operation>()
  fence?: Fence
  constructor(
    readonly instanceId: string,
    readonly token: string,
    readonly host: HostSocket,
    public transport: Transport,
    private readonly auth: AuthStore,
    private readonly leases: LeaseTable,
    private readonly timing: { heartbeatMs: number; leaseTtlMs: number },
    private readonly removed: () => void,
    private readonly resumed: () => void = () => {},
    private readonly claimed: () => void = () => {},
    private readonly uiReleases: readonly UiRelease[] = [],
  ) {
    this.timer = setTimeout(() => this.fail('HANDSHAKE_TIMEOUT'), HANDSHAKE_MS)
  }
  private current(): void {
    if (this.state === 'closed') throw new ProtocolError('STALE_CONTROL')
    this.host.current()
    if (
      this.auth.authorize(this.instanceId, this.token).authEpoch !==
      this.host.authEpoch
    )
      throw new ProtocolError('AUTH_REVOKED')
    if (
      this.fence &&
      this.leases.get(this.instanceId)?.controlId !== this.fence.controlId
    )
      throw new ProtocolError('STALE_CONTROL')
  }
  receive(data: Buffer, binary: boolean): void {
    try {
      this.current()
      if (binary) {
        if (this.state !== 'ready') throw new ProtocolError('INVALID_MESSAGE')
        const decoded = decodeChunk(data, this.host.limits)
        if (decoded.controlId !== this.fence!.controlId)
          throw new ProtocolError('STALE_CONTROL')
        if (this.lateBinary(decoded.id, 'upload')) return
        const transfer = this.chunk(data, 'upload')
        this.host.transport.sendChunk(data, () =>
          this.currentTransfer(transfer),
        )
        this.activity()
        return
      }
      if (this.state === 'hello') {
        const message = parseHandshake(data.toString(), this.host.limits)
        if (message.type !== 'browser.hello')
          throw new ProtocolError('INVALID_MESSAGE')
        negotiate(message.versions, [1])
        if (message.uiApi === 1) {
          const selected = selectUiProfile(this.host.uiProfile, this.host.runtimeId, this.uiReleases)
          if (selected.kind !== 'native') throw new ProtocolError('PROTOCOL_UNSUPPORTED')
          this.uiProfile = selected.profile
        }
        this.lease = this.leases.acquire(this.instanceId, message.resume, message.takeover === true)
        if (message.resume && !message.takeover) this.resumed()
        this.fence = {
          instanceId: this.instanceId,
          runtimeId: this.host.runtimeId,
          authEpoch: this.host.authEpoch,
          controlId: this.lease.controlId,
        }
        this.state = 'lease'
        this.claimed()
        this.transport.send({
          v: 1,
          type: 'relay.config',
          limits: this.host.limits,
          heartbeatMs: this.timing.heartbeatMs,
          leaseTtlMs: this.timing.leaseTtlMs,
        })
        this.transport.send({
          v: 1,
          type: 'browser.lease',
          id: this.lease.id,
          resumeSecret: this.lease.resumeSecret,
          fence: this.fence,
          expiresAt: this.lease.expiresAt,
        })
        return
      }
      if (this.state === 'lease') {
        const message = parseHandshake(data.toString(), this.host.limits)
        if (
          message.type !== 'browser.lease-ack' ||
          message.id !== this.lease!.id
        )
          throw new ProtocolError('INVALID_MESSAGE')
        this.acknowledged = true
        this.state = 'attach'
        clearTimeout(this.timer)
        void this.host
          .attach(this.fence!, this.lease!.id)
          .then(() => {
            if (this.state !== 'attach') return
            try {
              this.current()
              this.state = 'ready'
              this.transport.send(
                { v: 1, type: 'ready', fence: this.fence!, ...(this.uiProfile ? { uiProfile: this.uiProfile } : {}) },
                () => this.current(),
              )
            } catch (error) {
              this.fail(fault(error).code)
            }
          })
          .catch((error) => {
            if (this.state !== 'closed') this.fail(fault(error).code)
          })
        return
      }
      if (this.state !== 'ready') throw new ProtocolError('INVALID_MESSAGE')
      const message = parseController(data.toString(), this.host.limits)
      this.checkFence(message.fence)
      if (
        message.type === 'cancel' &&
        this.operations.get(message.id)?.cancelled
      )
        return
      if (message.type === 'upload.end' || message.type === 'download.credit') {
        const operation = this.operation(message.id)
        if (
          operation.kind !==
          (message.type === 'upload.end' ? 'upload' : 'download')
        )
          throw new ProtocolError('INVALID_MESSAGE')
        if (operation.state !== 'active') return
      }
      this.admit(message)
      this.current() // immediately before dispatch; never admit on stale authorization
      if (message.type !== 'heartbeat') {
        const transfer =
          message.type === 'upload.end'
            ? this.transfers.get(message.id)
            : undefined
        const operation = this.operations.get(message.id)!
        this.sendTracked(
          this.host.transport,
          message,
          operation,
          message.type === 'cancel',
          () => {
            if (message.type === 'cancel' && !operation.dispatched) {
              this.complete(operation)
              this.acknowledgeDrain(message.id, operation)
              throw new ProtocolError('TRANSFER_CLOSED')
            }
            operation.dispatched = true
            if (transfer) {
              this.currentTransfer(transfer)
              this.transfers.delete(message.id)
            }
          },
        )
      }
      this.activity()
    } catch (error) {
      this.fail(fault(error).code)
    }
  }
  fromHost(data: Buffer, binary: boolean): void {
    if (this.state !== 'ready') return
    try {
      this.current()
      if (binary) {
        const decoded = decodeChunk(data, this.host.limits)
        if (decoded.controlId !== this.fence!.controlId) return
        if (this.lateBinary(decoded.id, 'download')) return
        const transfer = this.chunk(data, 'download')
        this.transport.sendChunk(data, () => this.currentTransfer(transfer))
        return
      }
      const message = parseHost(data.toString(), this.host.limits)
      // A late old-generation response is discarded; it must never close a newer page.
      if (!sameFence(message.fence, this.fence!)) return
      const operation = this.operation(message.id)
      if (operation.state !== 'active') {
        const retiring = operation.state === 'retired'
        this.lateHost(message, operation)
        // Opted controllers retain a metadata tombstone until Host drain. Send
        // only that terminal fact, never a cancelled result or partial payload.
        if (retiring && operation.state === 'completed') this.acknowledgeDrain(message.id, operation)
        return
      }
      // Credits already in flight can race the ordered end (including empty files).
      // The known upload remains active awaiting its result; its window is closed.
      if (message.type === 'upload.credit' && operation.kind === 'upload' && (!this.transfers.has(message.id) || this.transfer(message.id, 'upload').ended)) return
      this.hostAdmission(message)
      const transfer =
        message.type === 'download.end'
          ? this.transfers.get(message.id)
          : undefined
      this.sendTracked(this.transport, message, operation, false, () => {
        if (transfer) {
          this.currentTransfer(transfer)
          this.transfers.delete(message.id)
        }
      })
    } catch (error) {
      this.fail(fault(error).code)
    }
  }
  private checkFence(fence: Fence): void {
    if (!this.fence || !sameFence(fence, this.fence))
      throw new ProtocolError('STALE_CONTROL')
  }
  private activity(): void {
    this.leases.heartbeat(this.instanceId, this.fence!.controlId)
  }
  private occupied(id: string): boolean {
    return (
      this.calls.has(id) ||
      this.watches.has(id) ||
      this.transfers.has(id) ||
      this.uploads.has(id)
    )
  }
  private admit(message: ControllerMessage): void {
    const limits = this.host.limits
    if ((message.type === 'call' && (['file.stat', 'file.text'].includes(message.command.op) || (message.command.op === 'file.read' && message.command.version !== undefined)) || message.type === 'watch' && message.watch.topic === 'file') && !this.host.uiProfile?.capabilities.includes(CURRENT_FILES_CAPABILITY)) throw new ProtocolError('PROTOCOL_UNSUPPORTED')
    if ((message.type === 'call' || message.type === 'watch') && message.fragments && !this.host.uiProfile?.capabilities.includes(LARGE_JSON_CAPABILITY)) throw new ProtocolError('PROTOCOL_UNSUPPORTED')
    if (
      message.type === 'call' ||
      message.type === 'watch' ||
      message.type === 'upload.open'
    ) {
      if (this.occupied(message.id) || this.operations.has(message.id))
        throw new ProtocolError('INVALID_MESSAGE')
    }
    switch (message.type) {
      case 'call':
        if (this.calls.size >= limits.calls)
          throw new ProtocolError('LIMIT_EXCEEDED')
        this.begin(message.id, 'call', message.command).fragments = message.fragments ? new JsonFragmentSequence() : undefined
        this.calls.set(message.id, {
          command: message.command,
          deadline: Date.now() + limits.callTimeoutMs,
        })
        break
      case 'watch':
        if (this.watches.size >= limits.streams)
          throw new ProtocolError('LIMIT_EXCEEDED')
        this.begin(message.id, 'watch').fragments = message.fragments ? new JsonFragmentSequence() : undefined
        this.watches.add(message.id)
        break
      case 'upload.open':
        if (this.uploads.size >= limits.uploads)
          throw new ProtocolError('LIMIT_EXCEEDED')
        this.begin(message.id, 'upload')
        this.uploads.set(message.id, Date.now() + limits.transferIdleMs)
        this.transfers.set(message.id, {
          window: new TransferWindow(message.bytes, limits),
          deadline: Date.now() + limits.transferIdleMs,
          direction: 'upload',
          cancelled: false,
          ended: false,
        })
        break
      case 'upload.end':
        this.finish(message.id, message.chunks, 'upload')
        this.uploads.set(message.id, Date.now() + limits.callTimeoutMs)
        break
      case 'download.credit':
        this.transfer(message.id, 'download').window.grant(message.chunks)
        break
      case 'cancel': {
        // Cancellation is explicit browser intent; disconnect/timeout never manufactures cancel.
        this.retire(message.id)
        break
      }
    }
  }
  private hostAdmission(message: HostMessage): void {
    const operation = this.operation(message.id)
    if (message.type !== 'json.fragment' && operation.fragments?.active) {
      if (!((message.type === 'end' && message.error) || (message.type === 'result' && !message.result.ok))) throw new ProtocolError('INVALID_MESSAGE')
      operation.fragments.clear(); operation.fragmentDeadline = undefined
    }
    switch (message.type) {
      case 'json.fragment': {
        if (this.fragment(message, operation) && operation.kind === 'call') { this.calls.delete(message.id); this.complete(operation) }
        break
      }
      case 'result': {
        const operation = this.operation(message.id)
        const call = this.calls.get(message.id)
        if (!call && !this.uploads.has(message.id))
          throw new ProtocolError('INVALID_MESSAGE')
        if (
          !call &&
          message.result.ok &&
          this.transfers.has(message.id) &&
          !this.transfers.get(message.id)!.ended
        )
          throw new ProtocolError('INVALID_MESSAGE')
        this.calls.delete(message.id)
        this.uploads.delete(message.id)
        this.dropTransfer(message.id)
        // Keep the opening identity non-evictable while admitting its download.
        // sendTracked pins this same token before any later frame can be processed.
        if (call?.command.op === 'file.read' && message.result.ok) {
          const meta = validateDownloadMetadata(
            message.result.value,
            this.host.limits,
          )
          if (meta.transferId === message.id)
            throw new ProtocolError('INVALID_MESSAGE')
          if (
            this.occupied(meta.transferId) ||
            this.operations.has(meta.transferId) ||
            this.transfers.size >=
              this.host.limits.calls + this.host.limits.uploads
          )
            throw new ProtocolError('LIMIT_EXCEEDED')
          if (
            meta.bytes > call.command.length ||
            meta.offset !== call.command.offset
          )
            throw new ProtocolError('INVALID_MESSAGE')
          this.begin(meta.transferId, 'download').dispatched = true
          operation.downloadId = meta.transferId
          this.transfers.set(meta.transferId, {
            window: new TransferWindow(meta.bytes, this.host.limits),
            deadline: Date.now() + this.host.limits.transferIdleMs,
            direction: 'download',
            cancelled: false,
            ended: false,
          })
        }
        this.complete(operation)
        break
      }
      case 'event':
        if (!this.watches.has(message.id))
          throw new ProtocolError('INVALID_MESSAGE')
        break
      case 'end':
        if (!this.watches.delete(message.id))
          throw new ProtocolError('INVALID_MESSAGE')
        this.complete(this.operation(message.id))
        break
      case 'upload.credit':
        this.transfer(message.id, 'upload').window.grant(message.chunks)
        break
      case 'download.end':
        this.transfer(message.id, 'download')
        if (message.error) this.dropTransfer(message.id)
        else this.finish(message.id, message.chunks, 'download')
        this.complete(this.operation(message.id))
        break
    }
  }
  private get retentionMs(): number {
    return Math.max(
      1000,
      this.host.limits.callTimeoutMs,
      this.host.limits.transferIdleMs,
    )
  }
  private get identityLimit(): number {
    const { calls, streams, uploads } = this.host.limits
    return Math.max(16, Math.min(4096, 4 * (calls + streams + uploads)))
  }
  private prune(now: number): void {
    for (const [id, operation] of this.operations) {
      if (
        operation.state === 'completed' &&
        operation.pending === 0 &&
        operation.deadline <= now
      )
        this.operations.delete(id)
    }
  }
  private begin(
    id: string,
    kind: OperationKind,
    command?: Operation['command'],
  ): Operation {
    this.prune(Date.now())
    if (this.operations.has(id)) throw new ProtocolError('INVALID_MESSAGE')
    if (this.operations.size >= this.identityLimit) {
      // Only a received ordered terminal proves that the previous identity drained.
      const completed = [...this.operations].find(
        ([, op]) => op.state === 'completed' && op.pending === 0,
      )
      if (completed) this.operations.delete(completed[0])
      else throw new ProtocolError('RESYNC_REQUIRED')
    }
    const operation: Operation = {
      kind,
      state: 'active',
      cancelled: false,
      dispatched: false,
      pending: 0,
      deadline: 0,
      command: command?.op === 'file.read' ? command : undefined,
    }
    this.operations.set(id, operation)
    return operation
  }
  private operation(id: string): Operation {
    const operation = this.operations.get(id)
    if (!operation) throw new ProtocolError('INVALID_MESSAGE')
    return operation
  }
  private complete(operation: Operation): void {
    operation.state = 'completed'
    operation.deadline = Date.now() + this.retentionMs
  }
  private retire(id: string): Operation {
    const operation = this.operation(id)
    operation.cancelled = true
    if (operation.state === 'active') {
      operation.state = 'retired'
      operation.deadline = Date.now() + this.retentionMs
    }
    this.calls.delete(id)
    this.watches.delete(id)
    this.dropTransfer(id)
    this.uploads.delete(id)
    if (
      operation.downloadId &&
      this.operations.get(operation.downloadId)?.state === 'active'
    )
      this.retire(operation.downloadId)
    if (operation.state === 'completed') this.acknowledgeDrain(id, operation)
    return operation
  }
  private acknowledgeDrain(id: string, operation: Operation): void {
    if (!operation.fragments || operation.drainAcknowledged) return
    operation.drainAcknowledged = true
    const error = { code: 'TRANSFER_CLOSED', message: 'TRANSFER_CLOSED', retryable: false }
    const drained: HostMessage = operation.kind === 'watch'
      ? { v: 1, type: 'end', id, fence: this.fence!, error }
      : { v: 1, type: 'result', id, fence: this.fence!, result: { ok: false, error } }
    this.sendTracked(this.transport, drained, operation, true)
  }
  private lateBinary(id: string, kind: 'upload' | 'download'): boolean {
    const operation = this.operation(id)
    if (operation.kind !== kind) throw new ProtocolError('INVALID_MESSAGE')
    return operation.state !== 'active'
  }
  private lateHost(message: HostMessage, operation: Operation): void {
    if (message.type === 'json.fragment') {
      if (operation.state === 'completed') throw new ProtocolError('INVALID_MESSAGE')
      if (this.fragment(message, operation) && operation.kind === 'call') this.complete(operation)
      return
    }
    const terminal =
      operation.kind === 'call' || operation.kind === 'upload'
        ? message.type === 'result'
        : operation.kind === 'watch'
          ? message.type === 'end'
          : message.type === 'download.end'
    const allowed =
      terminal ||
      (operation.kind === 'watch' && message.type === 'event') ||
      (operation.kind === 'upload' && message.type === 'upload.credit')
    if (!allowed) throw new ProtocolError('INVALID_MESSAGE')
    // A cancelled file.read can introduce its transfer after the call was retired.
    if (
      operation.state === 'retired' &&
      operation.command?.op === 'file.read' &&
      message.type === 'result' &&
      message.result.ok
    ) {
      const meta = validateDownloadMetadata(
        message.result.value,
        this.host.limits,
      )
      if (
        meta.transferId === message.id ||
        meta.offset !== operation.command.offset ||
        meta.bytes > operation.command.length
      )
        throw new ProtocolError('INVALID_MESSAGE')
      const download = this.begin(meta.transferId, 'download')
      download.dispatched = true
      this.retire(meta.transferId)
      operation.downloadId = meta.transferId
    }
    if (operation.fragments?.active) {
      if (!terminal) throw new ProtocolError('INVALID_MESSAGE')
      operation.fragments.clear(); operation.fragmentDeadline = undefined
    }
    if (terminal) this.complete(operation)
  }
  private fragment(message: Extract<HostMessage, { type: 'json.fragment' }>, operation: Operation): boolean {
    if (!operation.fragments || (operation.kind === 'call' ? message.logicalType !== 'result' : operation.kind !== 'watch' || message.logicalType !== 'event')) throw new ProtocolError('INVALID_MESSAGE')
    if (!operation.fragments.active) operation.fragmentDeadline = Date.now() + this.host.limits.callTimeoutMs
    if (operation.fragmentDeadline! <= Date.now()) throw new ProtocolError('TRANSFER_TIMEOUT')
    const done = operation.fragments.accept(message)
    if (done) operation.fragmentDeadline = undefined
    return done
  }
  private sendTracked(
    transport: Transport,
    message: ControllerMessage | HostMessage,
    operation: Operation,
    allowCancelled = false,
    dispatch?: () => void,
  ): void {
    operation.pending++
    try {
      transport.send(
        message,
        () => {
          this.current()
          if (operation.cancelled && !allowCancelled)
            throw new ProtocolError('TRANSFER_CLOSED')
          dispatch?.()
        },
        () => {
          operation.pending--
        },
      )
    } catch (error) {
      operation.pending--
      throw error
    }
  }
  private timeout(id: string, code: string): void {
    const operation = this.retire(id)
    const error = { code, message: code, retryable: false }
    const message: HostMessage =
      operation.kind === 'download'
        ? {
            v: 1,
            type: 'download.end',
            id,
            fence: this.fence!,
            chunks: 0,
            error,
          }
        : {
            v: 1,
            type: 'result',
            id,
            fence: this.fence!,
            result: { ok: false, error },
          }
    try {
      this.sendTracked(this.transport, message, operation, true)
    } catch (error) {
      this.fail(fault(error).code)
    }
  }
  private transfer(id: string, direction: Transfer['direction']): Transfer {
    const t = this.transfers.get(id)
    if (!t || t.direction !== direction)
      throw new ProtocolError('TRANSFER_CLOSED')
    return t
  }
  private currentTransfer(transfer: Transfer): void {
    this.current()
    if (transfer.cancelled) throw new ProtocolError('TRANSFER_CLOSED')
  }
  private chunk(data: Uint8Array, direction: Transfer['direction']): Transfer {
    const chunk = decodeChunk(data, this.host.limits)
    if (chunk.controlId !== this.fence!.controlId)
      throw new ProtocolError('STALE_CONTROL')
    const transfer = this.transfer(chunk.id, direction)
    if (chunk.index !== transfer.window.consume(chunk.data.length))
      throw new ProtocolError('INVALID_MESSAGE')
    transfer.deadline = Date.now() + this.host.limits.transferIdleMs
    if (direction === 'upload') this.uploads.set(chunk.id, transfer.deadline)
    return transfer
  }
  private finish(
    id: string,
    chunks: number,
    direction: Transfer['direction'],
  ): void {
    const transfer = this.transfer(id, direction)
    if (transfer.window.finish() !== chunks)
      throw new ProtocolError('INVALID_MESSAGE')
    transfer.ended = true
  }
  private dropTransfer(id: string): void {
    const transfer = this.transfers.get(id)
    if (transfer) {
      transfer.cancelled = true
      transfer.window.dispose()
    }
    this.transfers.delete(id)
  }
  sweep(now: number): void {
    if (this.state === 'closed') return
    try {
      this.current()
    } catch (error) {
      this.fail(fault(error).code)
      return
    }
    for (const [id, call] of this.calls)
      if (call.deadline <= now) this.timeout(id, 'RESULT_UNCERTAIN')
    for (const [id, transfer] of this.transfers)
      if (transfer.deadline <= now) this.timeout(id, 'TRANSFER_TIMEOUT')
    for (const [id, deadline] of this.uploads)
      if (deadline <= now) this.timeout(id, 'RESULT_UNCERTAIN')
    if ([...this.operations.values()].some(operation => operation.fragmentDeadline !== undefined && operation.fragmentDeadline <= now)) this.fail('RESYNC_REQUIRED')
    if (
      [...this.operations.values()].some(
        (operation) =>
          operation.state === 'retired' && operation.deadline <= now,
      )
    )
      this.fail('RESYNC_REQUIRED')
    this.prune(now)
  }

  fail(code: string): void {
    if (this.state === 'closed') return
    try {
      this.transport.send({
        v: 1,
        type: 'fault',
        error: {
          code,
          message: code,
          retryable: ['HOST_OFFLINE', 'RESYNC_REQUIRED'].includes(code),
        },
      })
    } catch {}
    this.dispose(false)
    // Let the bounded send queue emit fault before initiating close.
    setImmediate(() =>
      this.transport.close(code === 'LIMIT_EXCEEDED' ? 1009 : 1008, code),
    )
  }
  disconnected(): void {
    this.dispose(this.acknowledged && this.state === 'ready')
  }
  private dispose(resumable: boolean): void {
    if (this.state === 'closed') return
    this.state = 'closed'
    clearTimeout(this.timer)
    if (this.fence) {
      if (resumable)
        this.leases.disconnected(this.instanceId, this.fence.controlId)
      else this.leases.release(this.instanceId, this.fence.controlId)
      this.host.detach(this.fence)
    }
    for (const t of this.transfers.values()) {
      t.cancelled = true
      t.window.dispose()
    }
    this.transfers.clear()
    this.operations.clear()
    this.uploads.clear()
    this.calls.clear()
    this.watches.clear()
    this.removed()
  }
}
