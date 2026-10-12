import { expect, test, vi } from 'vitest'
import { DEFAULT_LIMITS, encodeChunk, CURRENT_FILES_CAPABILITY, NATIVE_UI_MARKER, RC2_UI_PROFILE } from '@dsh-web-control/protocol'
import { fixture, delay, hello } from './socket-fixture.ts'
const id = '30000000-0000-0000-0000-000000000005'
test.each([true, false])('Relay admits versioned file calls only with Host capability (%s)', async supported => {
  const f = await fixture()
  try {
    await f.register(); const cookie = await f.login()
    const h = await f.host({ ...hello, capabilities: supported ? [...RC2_UI_PROFILE.capabilities, NATIVE_UI_MARKER, CURRENT_FILES_CAPABILITY] : [] }); await h.next('relay.ack')
    const { b, fence } = await f.attach(h, cookie)
    b.send({ v: 1, type: 'call', id, fence, command: { op: 'file.stat', sessionId: 's', path: 'x' } })
    if (supported) {
      expect((await h.next('call')).command.op).toBe('file.stat')
      h.send({ v: 1, type: 'result', id, fence, result: { ok: true, value: { ok: false, code: 'missing' } } })
      expect((await b.next('result')).result.value).toEqual({ ok: false, code: 'missing' })
    } else {
      expect((await b.next('fault')).error.code).toBe('PROTOCOL_UNSUPPORTED')
      expect(h.messages.some(message => message.type === 'call')).toBe(false)
    }
  } finally { await f.close() }
})
test('call timeout reports uncertainty without synthesizing business cancel', async () => {
  const f = await fixture({
    limits: { ...DEFAULT_LIMITS, calls: 1, callTimeoutMs: 60 },
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
      id,
      fence,
      command: { op: 'session.list', workspaceId: 'w' },
    })
    await h.next('call')
    expect((await b.next('result')).result.error.code).toBe('RESULT_UNCERTAIN')
    expect(h.messages.some((m) => m.type === 'cancel')).toBe(false)
  } finally {
    await f.close()
  }
})
test('oversized JSON terminates with LIMIT_EXCEEDED; logs omit content and secrets', async () => {
  const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
  const f = await fixture({ limits: { ...DEFAULT_LIMITS, jsonBytes: 1024 } })
  try {
    await f.register()
    const cookie = await f.login()
    const h = await f.host()
    await h.next('relay.ack')
    const { b, fence } = await f.attach(h, cookie)
    b.send({
      v: 1,
      type: 'call',
      id,
      fence,
      command: {
        op: 'session.prompt',
        sessionId: 's',
        requestId: id,
        mode: 'queue',
        content: [{ kind: 'text', text: 'SENSITIVE_BODY'.repeat(200) }],
      },
    })
    expect((await b.next('fault')).error.code).toBe('LIMIT_EXCEEDED')
    expect(JSON.stringify(spy.mock.calls)).not.toContain('SENSITIVE_BODY')
    expect(JSON.stringify(spy.mock.calls)).not.toContain(cookie)
  } finally {
    await f.close()
    spy.mockRestore()
  }
})
test('aggregate event overflow closes slow controller with RESYNC_REQUIRED', async () => {
  const f = await fixture({
    limits: {
      ...DEFAULT_LIMITS,
      jsonBytes: 1024,
      bufferedBytes: 2048,
      chunkBytes: 128,
    },
  })
  try {
    await f.register()
    const cookie = await f.login()
    const h = await f.host()
    await h.next('relay.ack')
    const { b, fence } = await f.attach(h, cookie)
    b.send({ v: 1, type: 'watch', id, fence, watch: { topic: 'workspaces' } })
    await h.next('watch')
    const closed = new Promise<string>((resolve) =>
      b.ws.once('close', (_code, reason) => resolve(reason.toString())),
    )
    for (let i = 0; i < 12; i++)
      h.send({ v: 1, type: 'event', id, fence, value: 'x'.repeat(600) })
    expect(await closed).toBe('RESYNC_REQUIRED')
  } finally {
    await f.close()
  }
})
test('upload credits, chunk count and idle deadlines are enforced on actual frames', async () => {
  const f = await fixture({
    limits: { ...DEFAULT_LIMITS, transferIdleMs: 100 },
  })
  try {
    await f.register()
    const cookie = await f.login()
    const h = await f.host()
    await h.next('relay.ack')
    const { b, fence } = await f.attach(h, cookie)
    b.send({
      v: 1,
      type: 'upload.open',
      id,
      fence,
      sessionId: 's',
      name: 'file',
      mediaType: 'text/plain',
      bytes: 3,
    })
    await h.next('upload.open')
    h.send({ v: 1, type: 'upload.credit', id, fence, chunks: 1 })
    await b.next('upload.credit')
    b.ws.send(encodeChunk(id, fence.controlId, 0, new Uint8Array([1, 2, 3])))
    await h.next('binary')
    b.send({ v: 1, type: 'upload.end', id, fence, chunks: 1 })
    await h.next('upload.end')
    h.send({
      v: 1,
      type: 'result',
      id,
      fence,
      result: { ok: true, value: { receiptId: 'r' } },
    })
    await b.next('result')
    b.send({
      v: 1,
      type: 'upload.open',
      id: '30000000-0000-0000-0000-000000000007',
      fence,
      sessionId: 's',
      name: 'file',
      mediaType: 'text/plain',
      bytes: 3,
    })
    await h.next('upload.open')
    expect(['TRANSFER_TIMEOUT', 'RESULT_UNCERTAIN']).toContain(
      (await b.next('result')).result.error.code,
    )
    expect(h.messages.some((m) => m.type === 'cancel')).toBe(false)
  } finally {
    await f.close()
  }
})
test('binary without receiver credit closes the current generation', async () => {
  const f = await fixture()
  try {
    await f.register()
    const cookie = await f.login()
    const h = await f.host()
    await h.next('relay.ack')
    const { b, fence } = await f.attach(h, cookie)
    b.send({
      v: 1,
      type: 'upload.open',
      id,
      fence,
      sessionId: 's',
      name: 'f',
      mediaType: 'text/plain',
      bytes: 1,
    })
    await h.next('upload.open')
    b.ws.send(encodeChunk(id, fence.controlId, 0, new Uint8Array([1])))
    expect((await b.next('fault')).error.code).toBe('BACKPRESSURE')
  } finally {
    await f.close()
  }
})
test('call, watch and upload counts fail before forwarding the excess admission', async () => {
  for (const type of ['call', 'watch', 'upload.open'] as const) {
    const f = await fixture({
      limits: { ...DEFAULT_LIMITS, calls: 1, streams: 1, uploads: 1 },
    })
    try {
      await f.register()
      const cookie = await f.login()
      const h = await f.host()
      await h.next('relay.ack')
      const { b, fence } = await f.attach(h, cookie)
      const fields =
        type === 'call'
          ? { command: { op: 'session.list', workspaceId: 'w' } }
          : type === 'watch'
            ? { watch: { topic: 'workspaces' } }
            : { sessionId: 's', name: 'n', mediaType: 'text/plain', bytes: 1 }
      b.send({ v: 1, type, id, fence, ...fields })
      await h.next(type)
      b.send({
        v: 1,
        type,
        id: '30000000-0000-0000-0000-000000000006',
        fence,
        ...fields,
      })
      expect((await b.next('fault')).error.code).toBe('LIMIT_EXCEEDED')
      expect(h.messages.filter((m) => m.type === type)).toHaveLength(0)
    } finally {
      await f.close()
    }
  }
})
test('download result opens a distinct transfer ID and only download.end finishes it', async () => {
  const transferId = '50000000-0000-0000-0000-000000000005'
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
      id,
      fence,
      command: {
        op: 'file.read',
        sessionId: 's',
        path: 'p',
        offset: 0,
        length: 3,
      },
    })
    await h.next('call')
    h.send({
      v: 1,
      type: 'result',
      id,
      fence,
      result: {
        ok: true,
        value: {
          transferId,
          name: 'file',
          mediaType: 'text/plain',
          bytes: 3,
          offset: 0,
          eof: true,
        },
      },
    })
    await b.next('result')
    b.send({ v: 1, type: 'download.credit', id: transferId, fence, chunks: 1 })
    await h.next('download.credit')
    h.ws.send(
      encodeChunk(transferId, fence.controlId, 0, new Uint8Array([1, 2, 3])),
    )
    await b.next('binary')
    h.send({ v: 1, type: 'download.end', id: transferId, fence, chunks: 1 })
    expect((await b.next('download.end')).chunks).toBe(1)
  } finally {
    await f.close()
  }
})
test('ws maxPayload rejects oversized allocation before business parsing', async () => {
  const f = await fixture({
    limits: { ...DEFAULT_LIMITS, jsonBytes: 1024, chunkBytes: 128 },
  })
  try {
    await f.register()
    const cookie = await f.login()
    const h = await f.host()
    await h.next('relay.ack')
    const { b } = await f.attach(h, cookie)
    const closed = new Promise<number>((resolve) =>
      b.ws.once('close', (code) => resolve(code)),
    )
    b.ws.send('x'.repeat(2048))
    expect(await closed).toBe(1009)
  } finally {
    await f.close()
  }
})
test('upload.end remains behind its queued chunks even when control overtakes data', async () => {
  const f = await fixture()
  try {
    await f.register()
    const cookie = await f.login()
    const h = await f.host()
    await h.next('relay.ack')
    const { b, fence } = await f.attach(h, cookie)
    b.send({
      v: 1,
      type: 'upload.open',
      id,
      fence,
      sessionId: 's',
      name: 'f',
      mediaType: 'text/plain',
      bytes: 4,
    })
    await h.next('upload.open')
    h.send({ v: 1, type: 'upload.credit', id, fence, chunks: 4 })
    await b.next('upload.credit')
    const order: string[] = []
    h.ws.on('message', (data, binary) =>
      order.push(binary ? 'binary' : JSON.parse(data.toString()).type),
    )
    for (let i = 0; i < 4; i++)
      b.ws.send(encodeChunk(id, fence.controlId, i, new Uint8Array([i])))
    b.send({ v: 1, type: 'upload.end', id, fence, chunks: 4 })
    await h.next('upload.end')
    expect(order.slice(-5)).toEqual([
      'binary',
      'binary',
      'binary',
      'binary',
      'upload.end',
    ])
  } finally {
    await f.close()
  }
})
