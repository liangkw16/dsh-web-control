import { expect, test, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { DshUiReadAdapter, supportsNativeUi } from '../src/adapter/ui-rc2.ts'
import { SessionScope } from '../src/adapter/scope.ts'
const signal = new AbortController().signal
function setup() {
  let ids = ['s']
  const inspect = vi.fn(async () => ({ meta: { id: 's', createdAt: 42, cwd: '/workspace', agentPreset: 'private' }, events: ['not-shared'] }))
  const describe = vi.fn(() => [{ ns: 'llm', value: { key: 'secret' } }, { ns: 'ui-conversation', revision: 4, value: { busyEnter: 'steer', extra: 'not-shared' } }])
  const ctx = { sessionController: { inspect, updateQueue() {} }, settings: { describe }, typertGateway: { wireStream: { open() {} } } } as unknown as Context
  const scope = new SessionScope(() => [{ workspaceId: 'w', sessionIds: ids }])
  return { adapter: new DshUiReadAdapter(ctx, scope), inspect, describe, ctx, revoke: () => { ids = [] } }
}
test('UI reads return only selected actual Host facts and preferences', async () => {
  const f = setup(), admit = vi.fn()
  const facts = await f.adapter.read({ op: 'ui.read', view: 'host-facts' }, signal, admit)
  expect(facts).toEqual({ home: (await import('node:os')).homedir() })
  expect(await f.adapter.read({ op: 'ui.read', view: 'conversation-settings' }, signal, admit)).toEqual({ ns: 'ui-conversation', revision: 4, busyEnter: 'steer' })
  expect(f.describe).toHaveBeenCalledWith({ redactSecrets: true })
  expect(await f.adapter.read({ op: 'ui.read', view: 'session', sessionId: 's' }, signal, admit)).toEqual({ sessionId: 's', createdAt: 42, cwd: '/workspace' })
})
test('native capability depends on actual pinned runtime and required public services', () => {
  const f = setup()
  expect(supportsNativeUi(f.ctx, '0.2.0-rc.2')).toBe(true)
  expect(supportsNativeUi(f.ctx, '0.2.0')).toBe(false)
  expect(supportsNativeUi({} as Context, '0.2.0-rc.2')).toBe(false)
})
test('session read checks scope and current authority on both sides of await, never activates Agent', async () => {
  const f = setup()
  await expect(f.adapter.read({ op: 'ui.read', view: 'session', sessionId: 'private' }, signal, () => {})).rejects.toThrow('OUT_OF_SCOPE')
  expect(f.inspect).not.toHaveBeenCalled()
  const pending = Promise.withResolvers<any>(); f.inspect.mockReturnValue(pending.promise)
  const result = f.adapter.read({ op: 'ui.read', view: 'session', sessionId: 's' }, signal, () => {})
  f.revoke(); pending.resolve({ meta: { id: 's', createdAt: 42 } })
  await expect(result).rejects.toThrow('OUT_OF_SCOPE')
})
test('late replies cannot disclose data after fence revocation or abort', async () => {
  for (const abort of [false, true]) {
    const f = setup(), controller = new AbortController(), pending = Promise.withResolvers<any>(); let valid = true
    f.inspect.mockReturnValue(pending.promise)
    const result = f.adapter.read({ op: 'ui.read', view: 'session', sessionId: 's' }, controller.signal, () => { if (!valid) throw new Error('STALE_CONTROL') })
    if (abort) controller.abort(new Error('aborted')); else valid = false
    pending.resolve({ meta: { id: 's', createdAt: 42 } })
    await expect(result).rejects.toThrow(abort ? 'aborted' : 'STALE_CONTROL')
  }
})
test('missing or malformed actual preferences fail closed, never synthesize queue default', async () => {
  const f = setup()
  for (const view of [[], [{ ns: 'ui-conversation', revision: 0, value: { busyEnter: 'guess' } }]]) {
    f.describe.mockReturnValue(view as never)
    await expect(f.adapter.read({ op: 'ui.read', view: 'conversation-settings' }, signal, () => {})).rejects.toThrow()
  }
})
