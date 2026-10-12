import { expect, test } from 'vitest'
import { assertOrigin, cookieName, sessionCookie } from '../src/origin.ts'
const origin = 'https://control.example.com'
const instanceId = '11111111-1111-4111-8111-111111111111'
const token = Buffer.alloc(32, 5).toString('base64url')
test('only the configured canonical HTTPS origin is accepted', () => {
  expect(() => assertOrigin(origin, origin)).not.toThrow()
  expect(() => assertOrigin(`${origin}:8443`, `${origin}:8443`)).not.toThrow()
})
test.each([undefined, 'null', 'https://control.example.com.evil.test', 'https://evilcontrol.example.com', 'http://control.example.com', 'https://control.example.com:8443', 'https://user@control.example.com', `${origin}/`, `${origin}/path`, `${origin}/../`, `${origin}?`, `${origin}#`, `${origin}?a=b`, `${origin}#x`, `${origin} ${origin}`, ` ${origin}`, `${origin}\n`, 'https://control.example.com\\@evil.test'])('browser origin %s is denied', value => {
  expect(() => assertOrigin(value, origin)).toThrow('ORIGIN_DENIED')
})
test.each(['http://control.example.com', `${origin}/`, `${origin}/path`, 'https://user@control.example.com', `${origin}?`, 'not-a-url'])('invalid public origin %s fails closed', publicOrigin => {
  expect(() => assertOrigin(publicOrigin, publicOrigin)).toThrow('ORIGIN_DENIED')
})
test('cookie uses instance binding and exact secure browser flags and 30 day lifetime', () => {
  expect(cookieName(instanceId)).toBe(`__Host-dshc-${instanceId}`)
  expect(sessionCookie(instanceId, token)).toBe(`__Host-dshc-${instanceId}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=2592000`)
  expect(sessionCookie('22222222-2222-4222-8222-222222222222', token)).not.toBe(sessionCookie(instanceId, token))
})
test.each(['host-a', `${instanceId}; Domain=evil.test`, `${instanceId}\r\nInjected: true`])('invalid cookie instance %s fails', id => {
  expect(() => cookieName(id)).toThrow('INVALID_MESSAGE')
  expect(() => sessionCookie(id, token)).toThrow('INVALID_MESSAGE')
})
test('cookie value rejects injection and noncanonical secret encoding', () => {
  expect(() => sessionCookie(instanceId, 'token; Secure=false')).toThrow('INVALID_MESSAGE')
  expect(() => sessionCookie(instanceId, `${token}=`)).toThrow('INVALID_MESSAGE')
})
