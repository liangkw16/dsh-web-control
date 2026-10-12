import { createHash } from 'node:crypto'
import { expect, test } from 'vitest'
import { ProtocolError, validateId } from '@dsh-web-control/protocol'
import { LeaseTable } from '../src/leases.ts'
import { HostRoutes } from '../src/host-routes.ts'

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const R = '33333333-3333-4333-8333-333333333333'
const S = '44444444-4444-4444-8444-444444444444'
const T = '55555555-5555-4555-8555-555555555555'
const secret = Buffer.alloc(32, 9).toString('base64url')
function setup() {
  let now = 0
  return { leases: new LeaseTable({ now: () => now }, 30_000), time: (value: number) => { now = value } }
}
function fault(action: () => unknown, code: string) {
  expect(action).toThrow(ProtocolError)
  expect(action).toThrow(code)
}

test('concurrent acquire admits exactly one remote page per instance', async () => {
  const { leases } = setup()
  const results = await Promise.allSettled(Array.from({ length: 20 }, () => Promise.resolve().then(() => leases.acquire(A))))
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  for (const result of results) if (result.status === 'rejected') expect(result.reason).toMatchObject({ code: 'REMOTE_BUSY' })
  expect(() => leases.acquire(B)).not.toThrow()
})

test('copied storage and absent or wrong credentials cannot steal an online lease', () => {
  const { leases } = setup()
  const first = leases.acquire(A)
  for (const resume of [undefined, { id: first.id, secret: first.resumeSecret }, { id: first.id, secret }]) {
    fault(() => leases.acquire(A, resume), 'REMOTE_BUSY')
  }
  leases.heartbeat(A, first.controlId)
})

test('only disconnected lease may resume and the new control fences all old socket actions', () => {
  const { leases, time } = setup()
  const first = leases.acquire(A)
  time(1000); leases.disconnected(A, first.controlId)
  fault(() => leases.acquire(A), 'REMOTE_BUSY')
  fault(() => leases.acquire(A, { id: first.id, secret }), 'REMOTE_BUSY')
  fault(() => leases.acquire(A, { id: B, secret: first.resumeSecret }), 'REMOTE_BUSY')
  const resumed = leases.acquire(A, { id: first.id, secret: first.resumeSecret })
  expect(resumed.id).toBe(first.id)
  expect(resumed.resumeSecret).toBe(first.resumeSecret)
  expect(resumed.controlId).not.toBe(first.controlId)
  expect(resumed.expiresAt).toBe(31_000)
  fault(() => leases.heartbeat(A, first.controlId), 'STALE_CONTROL')
  leases.disconnected(A, first.controlId); leases.release(A, first.controlId)
  fault(() => leases.acquire(A, { id: first.id, secret: first.resumeSecret }), 'REMOTE_BUSY')
  leases.heartbeat(A, resumed.controlId)
})

test('disconnect near expiry and duplicates preserve the last activity deadline', () => {
  const { leases, time } = setup()
  const first = leases.acquire(A)
  time(29_000); leases.disconnected(A, first.controlId)
  time(29_999); leases.disconnected(A, first.controlId)
  fault(() => leases.heartbeat(A, first.controlId), 'STALE_CONTROL')
  fault(() => leases.acquire(A), 'REMOTE_BUSY')
  time(30_000); expect(leases.acquire(A).id).not.toBe(first.id)
})

test('online heartbeat uses server time and expiry at the deadline cannot be resurrected', () => {
  const { leases, time } = setup()
  const first = leases.acquire(A)
  time(29_999); leases.heartbeat(A, first.controlId)
  time(59_998); fault(() => leases.acquire(A), 'REMOTE_BUSY')
  time(59_999); fault(() => leases.heartbeat(A, first.controlId), 'STALE_CONTROL')
  const next = leases.acquire(A)
  expect(next.expiresAt).toBe(89_999)
  expect(next.id).not.toBe(first.id)
})

test('release frees immediately and old release, heartbeat or close cannot mutate a new lease', () => {
  const { leases } = setup()
  const first = leases.acquire(A)
  leases.release(A, first.controlId)
  const next = leases.acquire(A)
  leases.release(A, first.controlId); leases.disconnected(A, first.controlId)
  fault(() => leases.heartbeat(A, first.controlId), 'STALE_CONTROL')
  fault(() => leases.acquire(A), 'REMOTE_BUSY')
  leases.release(A, next.controlId); expect(() => leases.acquire(A)).not.toThrow()
})

test('lease results are detached, valid IDs and random canonical 32 byte secrets', () => {
  const { leases } = setup()
  const first = leases.acquire(A), original = { ...first }
  validateId(first.id); validateId(first.controlId)
  expect(first.id).not.toBe(first.controlId)
  expect(Buffer.from(first.resumeSecret, 'base64url')).toHaveLength(32)
  expect(Buffer.from(first.resumeSecret, 'base64url').toString('base64url')).toBe(first.resumeSecret)
  first.controlId = B; first.id = B; first.resumeSecret = secret; first.expiresAt = Infinity
  leases.disconnected(A, original.controlId)
  expect(leases.acquire(A, { id: original.id, secret: original.resumeSecret }).id).toBe(original.id)
  expect(leases.acquire(B).resumeSecret).not.toBe(original.resumeSecret)
})

test('internal lease storage retains a SHA-256 verifier and no plaintext resume secret', () => {
  const { leases } = setup()
  const first = leases.acquire(A)
  // Security invariant: inspect retained values, not a public diagnostic endpoint.
  const retained = Object.values(leases).filter(value => value instanceof Map).flatMap(value => [...value.values()])
  expect(retained).toHaveLength(1)
  const encoded = JSON.stringify(retained)
  expect(encoded).not.toContain(first.resumeSecret)
  expect(encoded).toContain(createHash('sha256').update(first.resumeSecret).digest('hex'))
})

test('explicit expiry sweep and clear release retained entries without autonomous timers', () => {
  const { leases, time } = setup()
  const first = leases.acquire(A); leases.acquire(B)
  time(30_000); expect(leases.sweepExpired()).toBe(2)
  expect(leases.sweepExpired()).toBe(0)
  const next = leases.acquire(A)
  leases.clear(); fault(() => leases.heartbeat(A, next.controlId), 'STALE_CONTROL')
  expect(leases.acquire(A).id).not.toBe(first.id)
})

test.each([0, -1, 1.5, NaN, Infinity, 2 ** 31])('invalid ttl %s fails closed', ttl => {
  fault(() => new LeaseTable({ now: () => 0 }, ttl), 'INVALID_MESSAGE')
})

test('malformed IDs, resume secrets, clock and overflowing deadlines cannot create leases', () => {
  const { leases, time } = setup()
  fault(() => leases.acquire('host-a'), 'INVALID_MESSAGE')
  fault(() => leases.acquire(A, { id: B, secret: 'short' }), 'INVALID_MESSAGE')
  fault(() => leases.acquire(A, { id: 'bad', secret }), 'INVALID_MESSAGE')
  for (const value of [-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER]) {
    time(value); fault(() => leases.acquire(A), 'INVALID_MESSAGE')
  }
  time(0); const lease = leases.acquire(A)
  for (const action of [() => leases.heartbeat(A, 'bad'), () => leases.disconnected('bad', lease.controlId), () => leases.release(A, 'bad')]) fault(action, 'INVALID_MESSAGE')
})

test('Host routes never replace a healthy socket, including cloned runtime IDs', () => {
  const routes = new HostRoutes()
  routes.claim(A, R, S); routes.claim(A, R, S)
  fault(() => routes.claim(A, R, T), 'HOST_ID_IN_USE')
  fault(() => routes.claim(A, B, T), 'HOST_ID_IN_USE')
  fault(() => routes.claim(A, B, S), 'HOST_ID_IN_USE')
  expect(routes.get(A)).toEqual({ runtimeId: R, socketId: S })
  routes.claim(B, R, T)
})

test('confirmed removal allows replacement and a delayed old socket close cannot remove it', () => {
  const routes = new HostRoutes()
  routes.claim(A, R, S)
  routes.remove(A, T)
  fault(() => routes.claim(A, B, T), 'HOST_ID_IN_USE')
  routes.remove(A, S); routes.remove(A, S)
  routes.claim(A, B, T); routes.remove(A, S)
  expect(routes.get(A)).toEqual({ runtimeId: B, socketId: T })
  const detached = routes.get(A)!
  detached.socketId = S
  expect(routes.get(A)?.socketId).toBe(T)
  routes.clear(); expect(routes.get(A)).toBeUndefined()
})

test('route input validation cannot retain malformed ownership', () => {
  const routes = new HostRoutes()
  for (const action of [() => routes.claim('bad', R, S), () => routes.claim(A, 'bad', S), () => routes.claim(A, R, 'bad'), () => routes.remove(A, 'bad'), () => routes.get('bad')]) fault(action, 'INVALID_MESSAGE')
  expect(routes.get(A)).toBeUndefined()
})

test('only an explicit claim replaces online/disconnected ownership; copied resume alone remains fenced', () => {
  const { leases } = setup(); const first = leases.acquire(A)
  const next = leases.acquire(A, { id: first.id, secret: first.resumeSecret }, true)
  expect(next.id).not.toBe(first.id); expect(next.resumeSecret).not.toBe(first.resumeSecret)
  leases.release(A, first.controlId); leases.disconnected(A, first.controlId)
  fault(() => leases.heartbeat(A, first.controlId), 'STALE_CONTROL'); leases.heartbeat(A, next.controlId)
  fault(() => leases.acquire(A, { id: first.id, secret: first.resumeSecret }), 'REMOTE_BUSY')
  leases.disconnected(A, next.controlId)
  fault(() => leases.acquire(A, { id: first.id, secret: first.resumeSecret }), 'REMOTE_BUSY')
  expect(leases.acquire(A, undefined, true).controlId).not.toBe(next.controlId)
})
