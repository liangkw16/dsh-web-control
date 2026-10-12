import { expect, test } from 'vitest'
import { fixture, delay } from '../../packages/relay/tests/socket-fixture.ts'
test('restart preserves authorization but never reuses old generation', async () => {
  const f = await fixture()
  try {
    await f.register()
    const cookie = await f.login()
    let h = await f.host()
    await h.next('relay.ack')
    const old = await f.attach(h, cookie)
    await f.restart()
    h = await f.host()
    await h.next('relay.ack')
    const current = await f.attach(h, cookie)
    expect(current.fence.controlId).not.toBe(old.fence.controlId)
    current.b.send({ v: 1, type: 'heartbeat', fence: old.fence })
    expect((await current.b.next('fault')).error.code).toBe('STALE_CONTROL')
    await delay(10)
    expect(h.messages.some((m) => m.type === 'cancel')).toBe(false)
  } finally {
    await f.close()
  }
})
