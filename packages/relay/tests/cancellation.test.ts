import { expect, test } from 'vitest'
import { DEFAULT_LIMITS, encodeChunk } from '@dsh-web-control/protocol'
import { fixture, delay } from './socket-fixture.ts'
const op = '30000000-0000-0000-0000-000000000011',
  keep = '30000000-0000-0000-0000-000000000012',
  transfer = '30000000-0000-0000-0000-000000000013'
for (const kind of ['call', 'watch', 'upload', 'download'] as const)
  test(`cancelled ${kind} discards in-flight frames and preserves unrelated watch`, async () => {
    const f = await fixture()
    try {
      await f.register()
      const cookie = await f.login()
      const h = await f.host()
      await h.next('relay.ack')
      const { b, fence } = await f.attach(h, cookie)
      b.send({
        v: 1,
        type: 'watch',
        id: keep,
        fence,
        watch: { topic: 'workspaces' },
      })
      await h.next('watch')
      if (kind === 'watch') {
        b.send({
          v: 1,
          type: 'watch',
          id: op,
          fence,
          watch: { topic: 'sessions' },
        })
        await h.next('watch')
      } else if (kind === 'upload') {
        b.send({
          v: 1,
          type: 'upload.open',
          id: op,
          fence,
          sessionId: 's',
          name: 'f',
          mediaType: 'text/plain',
          bytes: 1,
        })
        await h.next('upload.open')
      } else {
        b.send({
          v: 1,
          type: 'call',
          id: op,
          fence,
          command:
            kind === 'call'
              ? { op: 'session.list', workspaceId: 'w' }
              : {
                  op: 'file.read',
                  sessionId: 's',
                  path: 'p',
                  offset: 0,
                  length: 1,
                },
        })
        await h.next('call')
      }
      if (kind === 'download') {
        h.send({
          v: 1,
          type: 'result',
          id: op,
          fence,
          result: {
            ok: true,
            value: {
              transferId: transfer,
              name: 'f',
              mediaType: 'text/plain',
              bytes: 1,
              offset: 0,
              eof: true,
            },
          },
        })
        await b.next('result')
        b.send({
          v: 1,
          type: 'download.credit',
          id: transfer,
          fence,
          chunks: 1,
        })
        await h.next('download.credit')
      }
      b.send({
        v: 1,
        type: 'cancel',
        id: kind === 'download' ? transfer : op,
        fence,
      })
      await h.next('cancel')
      if (kind === 'call')
        h.send({
          v: 1,
          type: 'result',
          id: op,
          fence,
          result: { ok: true, value: 'late' },
        })
      if (kind === 'watch') {
        h.send({ v: 1, type: 'event', id: op, fence, value: 'late' })
        h.send({ v: 1, type: 'end', id: op, fence })
      }
      if (kind === 'upload') {
        h.send({ v: 1, type: 'upload.credit', id: op, fence, chunks: 1 })
        h.send({
          v: 1,
          type: 'result',
          id: op,
          fence,
          result: { ok: true, value: 'late' },
        })
      }
      if (kind === 'download') {
        h.ws.send(
          encodeChunk(transfer, fence.controlId, 0, new Uint8Array([1])),
        )
        h.send({ v: 1, type: 'download.end', id: transfer, fence, chunks: 1 })
      }
      h.send({ v: 1, type: 'event', id: keep, fence, value: 'alive' })
      expect((await b.next('event')).id).toBe(keep)
      await delay(20)
      expect(
        b.messages.some((m) =>
          [
            'fault',
            'result',
            'end',
            'upload.credit',
            'binary',
            'download.end',
          ].includes(m.type),
        ),
      ).toBe(false)
    } finally {
      await f.close()
    }
  })
test('file.read rejects transferId equal to opening call id', async () => {
  const f = await fixture()
  try {
    await f.register()
    const cookie = await f.login()
    const h = await f.host()
    await h.next('relay.ack')
    const { b, fence } = await f.attach(h, cookie)
    b.send({
      v: 1,
      type: 'call',
      id: op,
      fence,
      command: {
        op: 'file.read',
        sessionId: 's',
        path: 'p',
        offset: 0,
        length: 0,
      },
    })
    await h.next('call')
    h.send({
      v: 1,
      type: 'result',
      id: op,
      fence,
      result: {
        ok: true,
        value: {
          transferId: op,
          name: 'f',
          mediaType: 'text/plain',
          bytes: 0,
          offset: 0,
          eof: true,
        },
      },
    })
    expect((await b.next('fault')).error.code).toBe('INVALID_MESSAGE')
    expect(b.messages.some((m) => m.type === 'result')).toBe(false)
  } finally {
    await f.close()
  }
})
for (const kind of ['call', 'upload', 'download'] as const)
  test(`timed-out ${kind} ignores late completion while unrelated watch survives`, async () => {
    const f = await fixture({
      limits: { ...DEFAULT_LIMITS, callTimeoutMs: 80, transferIdleMs: 80 },
    })
    try {
      await f.register()
      const cookie = await f.login()
      const h = await f.host()
      await h.next('relay.ack')
      const { b, fence } = await f.attach(h, cookie)
      b.send({
        v: 1,
        type: 'watch',
        id: keep,
        fence,
        watch: { topic: 'workspaces' },
      })
      await h.next('watch')
      if (kind === 'upload') {
        b.send({
          v: 1,
          type: 'upload.open',
          id: op,
          fence,
          sessionId: 's',
          name: 'f',
          mediaType: 'text/plain',
          bytes: 1,
        })
        await h.next('upload.open')
      } else {
        b.send({
          v: 1,
          type: 'call',
          id: op,
          fence,
          command:
            kind === 'call'
              ? {
                  op: 'session.prompt',
                  sessionId: 's',
                  requestId: op,
                  mode: 'queue',
                  content: [{ kind: 'text', text: 'accepted' }],
                }
              : {
                  op: 'file.read',
                  sessionId: 's',
                  path: 'p',
                  offset: 0,
                  length: 1,
                },
        })
        await h.next('call')
      }
      if (kind === 'download') {
        h.send({
          v: 1,
          type: 'result',
          id: op,
          fence,
          result: {
            ok: true,
            value: {
              transferId: transfer,
              name: 'f',
              mediaType: 'text/plain',
              bytes: 1,
              offset: 0,
              eof: true,
            },
          },
        })
        await b.next('result')
        b.send({
          v: 1,
          type: 'download.credit',
          id: transfer,
          fence,
          chunks: 1,
        })
        await h.next('download.credit')
      }
      const expired = await b.next(
        kind === 'download' ? 'download.end' : 'result',
      )
      expect(
        kind === 'download' ? expired.error.code : expired.result.error.code,
      ).toBe(kind === 'call' ? 'RESULT_UNCERTAIN' : 'TRANSFER_TIMEOUT')
      if (kind === 'download') {
        h.ws.send(
          encodeChunk(transfer, fence.controlId, 0, new Uint8Array([1])),
        )
        h.send({ v: 1, type: 'download.end', id: transfer, fence, chunks: 1 })
      } else
        h.send({
          v: 1,
          type: 'result',
          id: op,
          fence,
          result: { ok: true, value: 'late' },
        })
      h.send({ v: 1, type: 'event', id: keep, fence, value: 'alive' })
      expect((await b.next('event')).id).toBe(keep)
      expect(
        h.messages.some((m) => m.type === 'cancel' || m.type === 'detach'),
      ).toBe(false)
      expect(b.messages.some((m) => m.type === 'fault')).toBe(false)
    } finally {
      await f.close()
    }
  })
test('queued terminal results and watch end survive completion; queued cancelled events stop', async () => {
  const f = await fixture()
  try {
    await f.register()
    const cookie = await f.login()
    const h = await f.host()
    await h.next('relay.ack')
    const { b, fence } = await f.attach(h, cookie)
    b.send({
      v: 1,
      type: 'watch',
      id: keep,
      fence,
      watch: { topic: 'workspaces' },
    })
    await h.next('watch')
    b.send({ v: 1, type: 'watch', id: op, fence, watch: { topic: 'sessions' } })
    await h.next('watch')
    let events = 0
    b.ws.on('message', (raw, binary) => {
      if (binary) return
      const m = JSON.parse(raw.toString())
      if (m.type === 'event' && m.id === op) {
        events++
        if (events === 1) b.send({ v: 1, type: 'cancel', id: op, fence })
      }
    })
    for (let i = 0; i < 60; i++)
      h.send({ v: 1, type: 'event', id: op, fence, value: 'x'.repeat(60000) })
    await h.next('cancel')
    h.send({ v: 1, type: 'end', id: op, fence })
    h.send({ v: 1, type: 'end', id: keep, fence })
    expect((await b.next('end')).id).toBe(keep)
    expect(events).toBeLessThan(60)
    expect(b.messages.some((m) => m.type === 'fault')).toBe(false)
    b.send({
      v: 1,
      type: 'call',
      id: transfer,
      fence,
      command: { op: 'session.list', workspaceId: 'w' },
    })
    await h.next('call')
    h.send({
      v: 1,
      type: 'result',
      id: transfer,
      fence,
      result: { ok: true, value: 'terminal' },
    })
    expect((await b.next('result')).result.value).toBe('terminal')
  } finally {
    await f.close()
  }
})
test('retired IDs cannot be reused and genuinely unknown Host IDs remain invalid', async () => {
  for (const reuse of [true, false]) {
    const f = await fixture()
    try {
      await f.register()
      const cookie = await f.login()
      const h = await f.host()
      await h.next('relay.ack')
      const { b, fence } = await f.attach(h, cookie)
      b.send({
        v: 1,
        type: 'call',
        id: op,
        fence,
        command: { op: 'session.list', workspaceId: 'w' },
      })
      await h.next('call')
      b.send({ v: 1, type: 'cancel', id: op, fence })
      await h.next('cancel')
      if (reuse)
        b.send({
          v: 1,
          type: 'call',
          id: op,
          fence,
          command: { op: 'session.list', workspaceId: 'w' },
        })
      else
        h.send({
          v: 1,
          type: 'result',
          id: transfer,
          fence,
          result: { ok: true, value: 'unknown' },
        })
      expect((await b.next('fault')).error.code).toBe('INVALID_MESSAGE')
    } finally {
      await f.close()
    }
  }
})
test('undrained retirement has a finite deadline without cancelling accepted work', async () => {
  const f = await fixture({
    limits: { ...DEFAULT_LIMITS, callTimeoutMs: 50, transferIdleMs: 50 },
  })
  try {
    await f.register()
    const cookie = await f.login()
    const h = await f.host()
    await h.next('relay.ack')
    const { b, fence } = await f.attach(h, cookie)
    b.send({
      v: 1,
      type: 'call',
      id: op,
      fence,
      command: { op: 'session.list', workspaceId: 'w' },
    })
    await h.next('call')
    expect((await b.next('result')).result.error.code).toBe('RESULT_UNCERTAIN')
    expect((await b.next('fault')).error.code).toBe('RESYNC_REQUIRED')
    expect(h.messages.some((m) => m.type === 'cancel')).toBe(false)
  } finally {
    await f.close()
  }
})
test('bounded retired identities force resync instead of evicting undrained ownership', async () => {
  const f = await fixture({
    limits: { ...DEFAULT_LIMITS, calls: 1, streams: 1, uploads: 1 },
  })
  try {
    await f.register()
    const cookie = await f.login()
    const h = await f.host()
    await h.next('relay.ack')
    const { b, fence } = await f.attach(h, cookie)
    for (let i = 0; i < 16; i++) {
      const id = `30000000-0000-0000-0000-${String(i).padStart(12, '0')}`
      b.send({
        v: 1,
        type: 'call',
        id,
        fence,
        command: { op: 'session.list', workspaceId: 'w' },
      })
      await h.next('call')
      b.send({ v: 1, type: 'cancel', id, fence })
      await h.next('cancel')
    }
    b.send({
      v: 1,
      type: 'call',
      id: '40000000-0000-0000-0000-000000000099',
      fence,
      command: { op: 'session.list', workspaceId: 'w' },
    })
    expect((await b.next('fault')).error.code).toBe('RESYNC_REQUIRED')
  } finally {
    await f.close()
  }
})
test('completed IDs expire safely after terminal delivery, while completed eviction stays bounded', async () => {
  const f = await fixture({
    limits: {
      ...DEFAULT_LIMITS,
      calls: 1,
      streams: 1,
      uploads: 1,
      callTimeoutMs: 80,
      transferIdleMs: 80,
    },
  })
  try {
    await f.register()
    const cookie = await f.login()
    const h = await f.host()
    await h.next('relay.ack')
    const { b, fence } = await f.attach(h, cookie)
    for (let i = 0; i < 18; i++) {
      const id = `30000000-0000-0000-0000-${String(i).padStart(12, '0')}`
      b.send({
        v: 1,
        type: 'call',
        id,
        fence,
        command: { op: 'session.list', workspaceId: 'w' },
      })
      await h.next('call')
      h.send({
        v: 1,
        type: 'result',
        id,
        fence,
        result: { ok: true, value: i },
      })
      expect((await b.next('result')).result.value).toBe(i)
    }
    await delay(1150)
    const id = '30000000-0000-0000-0000-000000000017'
    b.send({
      v: 1,
      type: 'call',
      id,
      fence,
      command: { op: 'session.list', workspaceId: 'w' },
    })
    await h.next('call')
    h.send({
      v: 1,
      type: 'result',
      id,
      fence,
      result: { ok: true, value: 'new' },
    })
    expect((await b.next('result')).result.value).toBe('new')
  } finally {
    await f.close()
  }
})
test('cancelled file.read can retire its late distinct download opener and frames', async () => {
  const f = await fixture()
  try {
    await f.register()
    const cookie = await f.login()
    const h = await f.host()
    await h.next('relay.ack')
    const { b, fence } = await f.attach(h, cookie)
    b.send({
      v: 1,
      type: 'watch',
      id: keep,
      fence,
      watch: { topic: 'workspaces' },
    })
    await h.next('watch')
    b.send({
      v: 1,
      type: 'call',
      id: op,
      fence,
      command: {
        op: 'file.read',
        sessionId: 's',
        path: 'p',
        offset: 0,
        length: 1,
      },
    })
    await h.next('call')
    b.send({ v: 1, type: 'cancel', id: op, fence })
    await h.next('cancel')
    h.send({
      v: 1,
      type: 'result',
      id: op,
      fence,
      result: {
        ok: true,
        value: {
          transferId: transfer,
          name: 'f',
          mediaType: 'text/plain',
          bytes: 1,
          offset: 0,
          eof: true,
        },
      },
    })
    h.ws.send(encodeChunk(transfer, fence.controlId, 0, new Uint8Array([1])))
    h.send({ v: 1, type: 'download.end', id: transfer, fence, chunks: 1 })
    h.send({ v: 1, type: 'event', id: keep, fence, value: 'alive' })
    expect((await b.next('event')).id).toBe(keep)
    expect(
      b.messages.some(
        (m) =>
          m.type === 'fault' ||
          m.type === 'result' ||
          m.type === 'binary' ||
          m.type === 'download.end',
      ),
    ).toBe(false)
  } finally {
    await f.close()
  }
})
test('cancel before opener dispatch suppresses both queued opener and its cancel', async () => {
  const f = await fixture()
  try {
    await f.register()
    const cookie = await f.login()
    const h = await f.host()
    await h.next('relay.ack')
    const { b, fence } = await f.attach(h, cookie)
    b.send({
      v: 1,
      type: 'watch',
      id: keep,
      fence,
      watch: { topic: 'workspaces' },
    })
    await h.next('watch')
    b.send({
      v: 1,
      type: 'call',
      id: op,
      fence,
      command: { op: 'session.list', workspaceId: 'w' },
    })
    b.send({ v: 1, type: 'cancel', id: op, fence })
    await delay(25)
    expect(h.messages.some((m) => m.id === op)).toBe(false)
    h.send({ v: 1, type: 'event', id: keep, fence, value: 'alive' })
    expect((await b.next('event')).id).toBe(keep)
  } finally {
    await f.close()
  }
})

test('download admission protects its opening call at the retired identity capacity', async () => {
  const f = await fixture({
    limits: { ...DEFAULT_LIMITS, calls: 1, streams: 1, uploads: 1 },
  })
  try {
    await f.register()
    const cookie = await f.login()
    const h = await f.host()
    await h.next('relay.ack')
    const { b, fence } = await f.attach(h, cookie)
    for (let i = 0; i < 15; i++) {
      const id = `40000000-0000-0000-0000-${String(i).padStart(12, '0')}`
      b.send({
        v: 1,
        type: 'call',
        id,
        fence,
        command: { op: 'session.list', workspaceId: 'w' },
      })
      await h.next('call')
      b.send({ v: 1, type: 'cancel', id, fence })
      await h.next('cancel')
    }
    b.send({
      v: 1,
      type: 'call',
      id: op,
      fence,
      command: {
        op: 'file.read',
        sessionId: 's',
        path: 'p',
        offset: 0,
        length: 0,
      },
    })
    await h.next('call')
    h.send({
      v: 1,
      type: 'result',
      id: op,
      fence,
      result: {
        ok: true,
        value: {
          transferId: transfer,
          name: 'f',
          mediaType: 'text/plain',
          bytes: 0,
          offset: 0,
          eof: true,
        },
      },
    })
    expect((await b.next('fault')).error.code).toBe('RESYNC_REQUIRED')
    expect(b.messages.some((m) => m.type === 'result')).toBe(false)
  } finally {
    await f.close()
  }
})

test('download admission protects the original token before queueing its terminal result', async () => {
  const { BrowserSocket } = await import('../src/browser-socket.ts')
  type Arguments = ConstructorParameters<typeof BrowserSocket>
  type RecordState = { state: string; dispatched: boolean; pending: number }
  const browser = new BrowserSocket(
    op,
    'synthetic-token',
    {
      limits: { ...DEFAULT_LIMITS, calls: 1, streams: 1, uploads: 1 },
    } as Arguments[2],
    {} as Arguments[3],
    {} as Arguments[4],
    {} as Arguments[5],
    { heartbeatMs: 10, leaseTtlMs: 30 },
    () => {},
  )
  // Exercise the actual admission/eviction methods directly, without replacing them.
  const state = browser as unknown as {
    timer: NodeJS.Timeout
    begin(id: string, kind: string, command?: unknown): RecordState
    retire(id: string): void
    hostAdmission(message: unknown): void
    calls: Map<string, unknown>
    operations: Map<string, RecordState>
  }
  clearTimeout(state.timer)
  for (let i = 0; i < 15; i++) {
    const id = `40000000-0000-0000-0000-${String(i).padStart(12, '0')}`
    state.begin(id, 'call').dispatched = true
    state.retire(id)
  }
  const command = {
    op: 'file.read',
    sessionId: 's',
    path: 'p',
    offset: 0,
    length: 0,
  }
  const original = state.begin(op, 'call', command)
  original.dispatched = true
  state.calls.set(op, { command, deadline: Date.now() + 1000 })
  expect(() =>
    state.hostAdmission({
      v: 1,
      type: 'result',
      id: op,
      result: {
        ok: true,
        value: {
          transferId: transfer,
          name: 'f',
          mediaType: 'text/plain',
          bytes: 0,
          offset: 0,
          eof: true,
        },
      },
    }),
  ).toThrow('RESYNC_REQUIRED')
  expect(state.operations.get(op)).toBe(original)
  expect(state.operations.has(transfer)).toBe(false)
  expect(state.operations.size).toBe(16)
})
