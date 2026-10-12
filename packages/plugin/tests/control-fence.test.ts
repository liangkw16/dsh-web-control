import { expect, test } from 'vitest'
import type { Fence } from '../../protocol/src/index.ts'
import type { Identity } from '../src/identity.ts'
import { HostFence } from '../src/control-fence.ts'

const A = '11111111-1111-4111-8111-111111111111'
const R = '22222222-2222-4222-8222-222222222222'
const C = '33333333-3333-4333-8333-333333333333'
const D = '44444444-4444-4444-8444-444444444444'
const incoming: Fence = { instanceId: A, runtimeId: R, controlId: C, authEpoch: 1 }
function setup() {
  let identity: Identity = { instanceId: A, deviceSecret: Buffer.alloc(32, 1).toString('base64url'), linkSecret: Buffer.alloc(32, 2).toString('base64url'), authEpoch: 1, enabled: true, relayOrigin: 'https://control.example.com' }
  return { gate: new HostFence(A, R, () => identity), update: (patch: Partial<Identity>) => { identity = { ...identity, ...patch } } }
}

test('Host admits only an installed matching full Fence', () => {
  const { gate } = setup()
  expect(() => gate.check(incoming)).toThrow('STALE_CONTROL')
  gate.install(incoming)
  expect(() => gate.check({ ...incoming })).not.toThrow()
  for (const patch of [{ instanceId: D }, { runtimeId: D }, { controlId: D }]) expect(() => gate.check({ ...incoming, ...patch })).toThrow('STALE_CONTROL')
  expect(() => gate.check(incoming)).not.toThrow()
})

test('replacement fences old actions, aborts old resource generation and copies input', () => {
  const { gate } = setup()
  gate.install(incoming); const old = gate.signal
  const next = { ...incoming, controlId: D }
  gate.install(next)
  expect(old.aborted).toBe(true); expect(gate.signal.aborted).toBe(false)
  next.controlId = C
  expect(() => gate.check(incoming)).toThrow('STALE_CONTROL')
  expect(() => gate.check({ ...incoming, controlId: D })).not.toThrow()
})

test('same installed Fence is idempotent; explicit invalidation blocks old generation until attach', () => {
  const { gate } = setup()
  expect(gate.signal.aborted).toBe(true)
  gate.install(incoming); const live = gate.signal
  gate.install({ ...incoming }); expect(gate.signal).toBe(live)
  gate.invalidate(); gate.invalidate()
  expect(live.aborted).toBe(true)
  expect(() => gate.check(incoming)).toThrow('STALE_CONTROL')
  gate.install({ ...incoming, controlId: D })
  expect(() => gate.check({ ...incoming, controlId: D })).not.toThrow()
})

test('identity rotation and stop revoke admission and dispose observer generation', () => {
  const { gate, update } = setup()
  gate.install(incoming); const old = gate.signal
  update({ authEpoch: 2 })
  expect(() => gate.check(incoming)).toThrow('AUTH_REVOKED')
  expect(old.aborted).toBe(true)
  expect(() => gate.install(incoming)).toThrow('AUTH_REVOKED')
  gate.install({ ...incoming, authEpoch: 2, controlId: D })
  const current = gate.signal
  update({ enabled: false, authEpoch: 3 })
  expect(() => gate.check({ ...incoming, authEpoch: 2, controlId: D })).toThrow('AUTH_REVOKED')
  expect(current.aborted).toBe(true)
  expect(() => gate.install({ ...incoming, authEpoch: 3, controlId: D })).toThrow('AUTH_REVOKED')
})

test('new epoch with old control cannot pass without a fresh installed attach', () => {
  const { gate, update } = setup()
  gate.install(incoming); update({ authEpoch: 2 })
  expect(() => gate.check({ ...incoming, authEpoch: 2 })).toThrow('STALE_CONTROL')
})

test('Fence recheck after an await rejects revoked admission while accepted work keeps running', async () => {
  const { gate, update } = setup()
  gate.install(incoming)
  let complete!: () => void
  let accepted = false
  const work = new Promise<void>(resolve => { complete = resolve })
  gate.check(incoming); accepted = true
  const admission = (async () => { gate.check(incoming); await Promise.resolve(); gate.check(incoming) })()
  update({ authEpoch: 2 })
  await expect(admission).rejects.toThrow('AUTH_REVOKED')
  complete(); await work; expect(accepted).toBe(true)
})

test('wrong runtime attach cannot revoke the valid controller', () => {
  const { gate } = setup()
  gate.install(incoming); const live = gate.signal
  expect(() => gate.install({ ...incoming, runtimeId: D })).toThrow('STALE_CONTROL')
  expect(() => gate.install({ ...incoming, instanceId: D })).toThrow('STALE_CONTROL')
  expect(live.aborted).toBe(false)
  expect(() => gate.check(incoming)).not.toThrow()
})

test('late revoked-epoch checks and installs cannot dispose the newer controller', () => {
  const { gate, update } = setup()
  gate.install(incoming); update({ authEpoch: 2 })
  const next = { ...incoming, authEpoch: 2, controlId: D }
  gate.install(next); const live = gate.signal
  expect(() => gate.check(incoming)).toThrow('AUTH_REVOKED')
  expect(() => gate.install(incoming)).toThrow('AUTH_REVOKED')
  expect(live.aborted).toBe(false)
  expect(() => gate.check(next)).not.toThrow()
})

test('corrupt identity fails closed and aborts its generation', () => {
  const { gate, update } = setup()
  gate.install(incoming); const live = gate.signal
  update({ authEpoch: 0 })
  expect(() => gate.check(incoming)).toThrow('IDENTITY_CORRUPT')
  expect(live.aborted).toBe(true)
})

test('invalid Fence fields and nonpositive epochs are rejected before install', () => {
  const { gate } = setup()
  for (const patch of [{ authEpoch: 0 }, { authEpoch: -1 }, { authEpoch: 1.5 }, { controlId: 'bad' }, { runtimeId: 'bad' }, { instanceId: 'bad' }]) {
    expect(() => gate.install({ ...incoming, ...patch })).toThrow('INVALID_MESSAGE')
    expect(() => gate.check({ ...incoming, ...patch })).toThrow('INVALID_MESSAGE')
  }
  expect(() => new HostFence('bad', R, () => ({} as Identity))).toThrow('INVALID_MESSAGE')
  expect(() => new HostFence(A, 'bad', () => ({} as Identity))).toThrow('INVALID_MESSAGE')
})
test('local identity rebind permanently rejects old captured admission and signal', () => {
  const { gate, update } = setup(); gate.install(incoming); const signal = gate.signal, admission = () => gate.check(incoming)
  update({ instanceId: D }); gate.rebind(D, R); const next = { ...incoming, instanceId: D }; gate.install(next)
  expect(signal.aborted).toBe(true); expect(admission).toThrow(); expect(() => gate.check(next)).not.toThrow()
})
