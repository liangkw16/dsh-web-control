import { test, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { DEFAULT_LIMITS, parseController, parseHostUiProfile, RC2_UI_PROFILE, hostUiProfileFromCapabilities, NATIVE_UI_MARKER } from '../src/index.ts'
import { CURRENT_FILES_CAPABILITY, parseCurrentFileStat, parseCurrentFileText } from '../src/current-files.ts'
const fence = { instanceId: randomUUID(), runtimeId: randomUUID(), controlId: randomUUID(), authEpoch: 1 }
const parse = (command: unknown) => parseController(JSON.stringify({ v: 1, type: 'call', id: randomUUID(), fence, command }), DEFAULT_LIMITS)
test('optional file capability leaves old profiles valid and survives native selection', () => {
  expect(parseHostUiProfile(RC2_UI_PROFILE)).toEqual(RC2_UI_PROFILE)
  expect(hostUiProfileFromCapabilities([...RC2_UI_PROFILE.capabilities, NATIVE_UI_MARKER, CURRENT_FILES_CAPABILITY])?.capabilities).toContain(CURRENT_FILES_CAPABILITY)
})
test('file commands and watch have finite versioned shapes', () => {
  expect(parse({ op: 'file.stat', sessionId: 's', path: 'img.png', baseFile: 'doc.md' }).type).toBe('call')
  expect(parse({ op: 'file.text', sessionId: 's', path: 'x', version: 'v', offset: 1, limit: 5000 }).type).toBe('call')
  expect(parse({ op: 'file.read', sessionId: 's', path: 'x', version: 'v', offset: 0, length: 100 }).type).toBe('call')
  expect(parseController(JSON.stringify({ v: 1, type: 'watch', id: randomUUID(), fence, watch: { topic: 'file', sessionId: 's', path: 'x' } }), DEFAULT_LIMITS).type).toBe('watch')
})
test.each([
  { op: 'file.stat', sessionId: 's', path: 'x', namespace: 'fs' },
  { op: 'file.text', sessionId: 's', path: 'x', offset: 1, limit: 2 },
  ...[-1, 0, Number.MAX_SAFE_INTEGER].map(offset => ({ op: 'file.text', sessionId: 's', path: 'x', version: 'v', offset, limit: 2 })),
  { op: 'file.text', sessionId: 's', path: 'x', version: 'v', offset: 1, limit: 5001 },
  { op: 'file.read', sessionId: 's', path: 'x', version: 'v', offset: 0, length: 1024 * 1024 + 1 },
])('refuses malformed file operation %j', command => expect(() => parse(command)).toThrow('INVALID_MESSAGE'))
test('file result validators reject additional fields and malformed ranges', () => {
  const value = { absolutePath: '/workspace/x', relativePath: 'x', version: 'v', bytes: 10 }
  expect(parseCurrentFileStat({ ok: true, value })).toEqual({ ok: true, value })
  expect(parseCurrentFileStat({ ok: false, code: 'changed' })).toEqual({ ok: false, code: 'changed' })
  for (const result of [{ ok: false, code: 'EACCES', path: '/private' }, { ok: true, value: { ...value, token: 'private' } }]) expect(() => parseCurrentFileStat(result)).toThrow('INVALID_MESSAGE')
  expect(() => parseCurrentFileText({ ok: true, value: { absolutePath: '/w/x', version: 'v', bytes: 2, offset: 0, text: 'x', lines: 1, eof: true } })).toThrow('INVALID_MESSAGE')
})
