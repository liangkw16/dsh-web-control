import { expect, test } from 'vitest'
import { DEFAULT_LIMITS, parseController, parseHandshake } from '../src/index.ts'
import { RC2_UI_PROFILE, parseHostUiProfile, parseUiSelection, parseUiReadResult } from '../src/ui-profile.ts'
const runtimeId = '20000000-0000-0000-0000-000000000001'
const fence = { instanceId: runtimeId, runtimeId, controlId: runtimeId, authEpoch: 1 }
const profile = { host: RC2_UI_PROFILE, runtimeId, uiRevision: 'a'.repeat(64) }
const call = (command: unknown) => parseController(JSON.stringify({ v: 1, type: 'call', id: runtimeId, fence, command }), DEFAULT_LIMITS)
test('native profiles are finite, complete and reject extra authority', () => {
  expect(parseHostUiProfile(RC2_UI_PROFILE)).toEqual(RC2_UI_PROFILE)
  for (const bad of [{}, { ...RC2_UI_PROFILE, adapter: 'guess' }, { ...RC2_UI_PROFILE, capabilities: [] }, { ...RC2_UI_PROFILE, capabilities: [...RC2_UI_PROFILE.capabilities, 'exec'] }, { ...RC2_UI_PROFILE, capabilities: [...RC2_UI_PROFILE.capabilities, RC2_UI_PROFILE.capabilities[0]] }, { ...RC2_UI_PROFILE, localhostToken: 'x' }]) expect(() => parseHostUiProfile(bad)).toThrow()
  expect(parseUiSelection({ kind: 'native', profile })).toEqual({ kind: 'native', profile })
  expect(parseUiSelection({ kind: 'legacy', runtimeId })).toEqual({ kind: 'legacy', runtimeId })
  for (const bad of [{ kind: 'native', profile: { ...profile, runtimeId: 'runtime-a' } }, { kind: 'native', profile: { ...profile, uiRevision: '../x' } }, { kind: 'legacy', runtimeId, profile }, { kind: 'unavailable', code: 'AUTH_REQUIRED' }]) expect(() => parseUiSelection(bad)).toThrow()
})
test('optional UI negotiation preserves old ready and validates new ready against its runtime', () => {
  const parse = (value: unknown) => parseHandshake(JSON.stringify(value), DEFAULT_LIMITS)
  expect(parse({ v: 1, type: 'ready', fence })).toEqual({ v: 1, type: 'ready', fence })
  expect(parse({ v: 1, type: 'browser.hello', versions: [1], uiApi: 1 })).toHaveProperty('uiApi', 1)
  expect(parse({ v: 1, type: 'ready', fence, uiProfile: profile })).toHaveProperty('uiProfile', profile)
  expect(() => parse({ v: 1, type: 'browser.hello', versions: [1], uiApi: 2 })).toThrow()
  expect(() => parse({ v: 1, type: 'ready', fence, uiProfile: { ...profile, runtimeId: '30000000-0000-0000-0000-000000000001' } })).toThrow()
})
test('UI reads have only three strict views, no arbitrary RPC or settings path', () => {
  for (const command of [{ op: 'ui.read', view: 'host-facts' }, { op: 'ui.read', view: 'conversation-settings' }, { op: 'ui.read', view: 'session', sessionId: 's' }]) expect(call(command)).toHaveProperty('command', command)
  for (const command of [{ op: 'ui.read', view: 'credentials' }, { op: 'ui.read', view: 'session' }, { op: 'ui.read', view: 'host-facts', sessionId: 's' }, { op: 'ui.read', view: 'conversation-settings', namespace: 'llm' }]) expect(() => call(command)).toThrow()
  expect(parseUiReadResult('host-facts', { home: '/home/test' })).toEqual({ home: '/home/test' })
  expect(parseUiReadResult('conversation-settings', { ns: 'ui-conversation', revision: 2, busyEnter: 'steer' })).toHaveProperty('busyEnter', 'steer')
  expect(parseUiReadResult('session', { sessionId: 's', createdAt: 0, cwd: '/test' })).toHaveProperty('sessionId', 's')
  for (const [view, data] of [['host-facts', { home: '/home', token: 'bad' }], ['conversation-settings', { ns: 'llm', revision: 1, busyEnter: 'queue' }], ['conversation-settings', { ns: 'ui-conversation', revision: -1, busyEnter: 'queue' }], ['session', { sessionId: 's', createdAt: 0, events: [] }]] as const) expect(() => parseUiReadResult(view, data)).toThrow()
})
test('native queue actions are text-only and bounded to one identified pending item', () => {
  for (const action of [{ kind: 'edit', content: [{ type: 'text', text: 'replacement' }] }, { kind: 'remove' }, { kind: 'steer' }]) expect(call({ op: 'session.queue', sessionId: 's', itemId: 'message-1', action })).toHaveProperty('command.action', action)
  for (const action of [{ kind: 'move' }, { kind: 'edit', content: [] }, { kind: 'edit', content: [{ type: 'file', path: '/private' }] }, { kind: 'remove', all: true }, { kind: 'edit', content: [{ type: 'text', text: '' }] }]) expect(() => call({ op: 'session.queue', sessionId: 's', itemId: 'i', action })).toThrow()
  expect(() => call({ op: 'session.queue', sessionId: 's', action: { kind: 'steer' } })).toThrow()
})
test('native history turn-window survives page/follow wire validation with finite bounds', () => {
  const turnWindow = { minMessages: 8, minTurns: 2 }
  expect(call({ op: 'session.page', sessionId: 's', throughSeq: 40, maxMessages: 32, turnWindow })).toHaveProperty('command.turnWindow', turnWindow)
  expect(parseController(JSON.stringify({ v: 1, type: 'watch', id: runtimeId, fence, watch: { topic: 'session', sessionId: 's', maxMessages: 32, turnWindow } }), DEFAULT_LIMITS)).toHaveProperty('watch.turnWindow', turnWindow)
  for (const bad of [{ minMessages: 33, minTurns: 1 }, { minMessages: -1, minTurns: 2 }, { minMessages: 8, minTurns: 0.5 }, { minMessages: 8, minTurns: 2, secret: 1 }]) expect(() => call({ op: 'session.page', sessionId: 's', throughSeq: 40, maxMessages: 32, turnWindow: bad })).toThrow()
})
