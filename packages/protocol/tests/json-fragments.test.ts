import { expect, test } from 'vitest'
import { DEFAULT_LIMITS, JsonFragmentSequence, MAX_LOGICAL_JSON_BYTES, assembledHost, fragmentJson, parseController, parseHost, type HostMessage } from '../src/index.ts'
const id = '11111111-1111-4111-8111-111111111111'
const fence = { instanceId: id, runtimeId: id, controlId: id, authEpoch: 1 }
const envelope = (value: string): Extract<HostMessage, { type: 'event' }> => ({ v: 1, type: 'event', id, fence, value })
test('large original JSON round trips escaped text and emoji at a fragment boundary', () => {
  const prefix = JSON.stringify(envelope('')).indexOf('"value":"') + 9
  const message = envelope('a'.repeat(16383 - prefix) + '🚀' + '中\\\n"🚀'.repeat(30000))
  const text = JSON.stringify(message), parts = [...fragmentJson(message, text, DEFAULT_LIMITS)]
  const sequence = new JsonFragmentSequence()
  expect(parts.length).toBeGreaterThan(1)
  parts.forEach((part, index) => { expect(parseHost(JSON.stringify(part), DEFAULT_LIMITS)).toEqual(part); expect(sequence.accept(part)).toBe(index === parts.length - 1) })
  expect(assembledHost(parts.map(part => part.data).join(''), parts.at(-1)!, DEFAULT_LIMITS)).toEqual(message)
  expect(sequence.active).toBe(false)
})
test('bounded splitter refuses tiny frame limits and bodies above the logical ceiling', () => {
  const message = envelope('🚀'.repeat(100))
  expect(() => [...fragmentJson(message, JSON.stringify(message), { ...DEFAULT_LIMITS, jsonBytes: 1030 })]).toThrow('LIMIT_EXCEEDED')
  expect(() => [...fragmentJson(message, 'a'.repeat(MAX_LOGICAL_JSON_BYTES + 1), DEFAULT_LIMITS)]).toThrow('JSON exceeds')
})
test.each(['order', 'count', 'bytes', 'type'])('fragment %s mismatch fails without delivering a body', variant => {
  const message = envelope('a'.repeat(300000)), parts = [...fragmentJson(message, JSON.stringify(message), DEFAULT_LIMITS)]
  const sequence = new JsonFragmentSequence(); sequence.accept(parts[0])
  const changed = { ...parts[1], ...(variant === 'order' ? { index: 2 } : variant === 'count' ? { parts: 99 } : variant === 'bytes' ? { bytes: 1 } : { logicalType: 'result' as const }) }
  expect(() => sequence.accept(changed)).toThrow()
})
test.each(['id', 'fence', 'type', 'nested'])('assembled %s mismatch cannot cross operation authority', variant => {
  const message = envelope('a'.repeat(300000)), parts = [...fragmentJson(message, JSON.stringify(message), DEFAULT_LIMITS)]
  const changed = variant === 'nested' ? parts[0] : variant === 'id' ? { ...message, id: '22222222-2222-4222-8222-222222222222' } : variant === 'fence' ? { ...message, fence: { ...fence, authEpoch: 2 } } : { v: 1, type: 'result', id, fence, result: { ok: true, value: 'x' } }
  expect(() => assembledHost(JSON.stringify(changed), parts[0], DEFAULT_LIMITS)).toThrow('INVALID_MESSAGE')
})
test.each(['file.read', 'session.stop', 'session.create'])('fragment opt-in cannot widen %s', op => {
  const command = op === 'file.read' ? { op, sessionId: 's', path: 'a', offset: 0, length: 1 } : op === 'session.stop' ? { op, sessionId: 's', stopToken: 't' } : { op, sessionId: 's', workspaceId: 'w' }
  expect(() => parseController(JSON.stringify({ v: 1, type: 'call', id, fence, command, fragments: true }), DEFAULT_LIMITS)).toThrow('INVALID_MESSAGE')
})

import { prepareJson } from '../src/index.ts'
test('incremental Host serialization matches JSON.stringify for nested unicode and escaped values', () => {
  const message = { v: 1, type: 'result', id, fence, result: { ok: true, value: { array: [null, -0, true, { '键🚀': '"\\\n中🚀\ud800'.repeat(32000) }], empty: [], object: {} } } } as const
  const prepared = prepareJson(JSON.parse(JSON.stringify(message)), DEFAULT_LIMITS), parts = [...prepared.fragments()]
  const text = parts.map(part => part.data).join(''); expect(text).toBe(JSON.stringify(message)); expect(prepared.bytes).toBe(Buffer.byteLength(text))
  const sequence = new JsonFragmentSequence(); for (const part of parts) sequence.accept(part)
  expect(sequence.active).toBe(false)
})
test('incremental serialization never invokes getters or toJSON', () => {
  for (const value of [{ get secret() { throw Error('getter executed') } }, { toJSON() { throw Error('toJSON executed') } }]) {
    expect(() => prepareJson({ v: 1, type: 'event', id, fence, value: value as any }, DEFAULT_LIMITS)).toThrow('INVALID_MESSAGE')
  }
})
