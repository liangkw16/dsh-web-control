import { expect, test, vi } from 'vitest'
import { systemFixture, prompt } from '../support/host-driver.ts'
test('query cancellation drains production observer ownership without stopping accepted Agent', async () => {
  const f = await systemFixture()
  try {
    await f.browser.transport.call(prompt()); const abort = new AbortController(), iterator = f.browser.transport.watch({ topic: 'session', sessionId: 'a', maxMessages: 64 }, abort.signal)[Symbol.asyncIterator]()
    expect((await iterator.next()).done).toBe(false); abort.abort(); await iterator.return?.()
    await vi.waitFor(() => expect(f.host.observers()).toBe(1))
    expect(f.host.running('a')).toBe(true); expect(f.host.nativeCancels).toBe(0)
    await f.host.quit(); expect(f.host.observers()).toBe(0); expect(f.host.transport.budget.bytes).toBe(0)
    const sockets = (f.host.transport as unknown as { sockets: Set<unknown> }).sockets
    expect(sockets.size).toBe(0)
  } finally { await f.close() }
})
test('local pending answer wins exactly once against a late remote answer', async () => {
  const f = await systemFixture(), abort = new AbortController()
  try {
    const iterator = f.browser.transport.watch({ topic: 'interactions' }, abort.signal)[Symbol.asyncIterator]()
    await iterator.next(); const value = (await iterator.next()).value as any
    expect(value.kind).toBe('interaction'); f.host.localAnswer(); await iterator.next()
    await expect(f.browser.transport.call({ op: 'interaction.answer', deliveryId: value.deliveryId, answer: 'allowed-once' })).rejects.toThrow('STALE_ACTION')
    expect(f.host.decisions).toEqual(['approval-a']); expect(f.host.pendingApprovals()).toEqual([])
    abort.abort(); await iterator.return?.()
  } finally { abort.abort(); await f.close() }
})

test('RelayDriver counters retire exact abruptly closed peer generation', async () => {
  const f = await systemFixture(), abort = new AbortController()
  try {
    const iterator = f.browser.transport.watch({ topic: 'session', sessionId: 'a', maxMessages: 64 }, abort.signal)[Symbol.asyncIterator]()
    await iterator.next(); await vi.waitFor(() => expect(f.relay.metrics().activeStreams).toBeGreaterThan(0))
    f.browser.disconnect(); await vi.waitFor(() => expect(f.relay.metrics()).toMatchObject({ activeStreams: 0, activeTransfers: 0 }))
    abort.abort(); await iterator.return?.()
  } finally { abort.abort(); await f.close() }
})
