import { expect, test, vi } from 'vitest'
import { parseManage } from '../src/management.ts'
import { ManagementStore } from '../src/client/management-store.ts'
import { parseController, DEFAULT_LIMITS } from '../../protocol/src/index.ts'
test('local management has explicit actions and cannot pass remote allowlist', () => {
  expect(parseManage({ action: 'resume' })).toEqual({ action: 'resume' })
  expect(() => parseManage({ action: 'resume', relayOrigin: 'https://other.example' })).toThrow()
  expect(parseManage({ action: 'configure', relayOrigin: 'https://relay.example', enrollmentSecret: 'transient' })).toEqual({ action: 'configure', relayOrigin: 'https://relay.example', enrollmentSecret: 'transient' })
  expect(() => parseManage({ action: 'fetch', url: '/api/session/cancel' })).toThrow()
  expect(() => parseManage({ action: 'status', secret: 'x' })).toThrow()
  expect(() => parseController(JSON.stringify({ v: 1, type: 'call', id: '44444444-4444-4444-8444-444444444444', fence: { instanceId: '11111111-1111-4111-8111-111111111111', runtimeId: '22222222-2222-4222-8222-222222222222', controlId: '33333333-3333-4333-8333-333333333333', authEpoch: 1 }, command: { op: 'web-control/manage', action: 'stop' } }), DEFAULT_LIMITS)).toThrow()
})
test('closing settings only clears presentation; never stops remote control', async () => {
  const call = vi.fn().mockResolvedValue({ status: { phase: 'ready', instanceId: 'one', controllerPresent: true }, link: 'https://relay.example/connect/one#key=secret' })
  const store = new ManagementStore(call); await store.refresh(); store.close()
  expect(call).toHaveBeenCalledTimes(1); expect(call).toHaveBeenCalledWith({ action: 'status' }); expect(store.snapshot().link).toBeNull()
})
test('replacement is an explicit local action requiring a deployment credential', () => {
  expect(() => parseManage({ action: 'replace-registration', relayOrigin: 'https://relay.example' })).toThrow()
  expect(parseManage({ action: 'replace-registration', relayOrigin: 'https://relay.example', enrollmentSecret: 'A'.repeat(43) }).action).toBe('replace-registration')
})

const ready = { status: { phase: 'ready' as const, instanceId: 'one', controllerPresent: false }, link: 'https://relay.example/connect/one#key=owned-test' }
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }

test('unchanged background refresh retains snapshot identity and never publishes pending busy', async () => {
  const store = new ManagementStore(async () => structuredClone(ready)); await store.refresh()
  const settled = store.snapshot(), listener = vi.fn(); store.subscribe(listener)
  const polling = store.refresh(); expect(store.snapshot()).toBe(settled); expect(store.snapshot().busy).toBe(false)
  await polling; await store.refresh(); expect(store.snapshot()).toBe(settled); expect(listener).not.toHaveBeenCalled()
})
test('background refresh deduplicates an in-flight request and propagates changed native fields', async () => {
  const pending = deferred<typeof ready>(); let calls = 0
  const store = new ManagementStore(async () => { calls++; return pending.promise })
  const first = store.refresh(), duplicate = store.refresh(); expect(first).toBe(duplicate); expect(calls).toBe(1)
  pending.resolve(ready); await first
  const listener = vi.fn()
  const updates = [
    { ...ready, status: { ...ready.status, controllerPresent: true } },
    { link: null, status: { ...ready.status, phase: 'offline' as const, code: 'HOST_OFFLINE' } },
    { ...ready, link: 'https://relay.example/connect/one#key=new-owned-test' },
  ]
  const changing = new ManagementStore(async () => updates.shift()!); changing.subscribe(listener)
  await changing.refresh(); expect(changing.snapshot().status.controllerPresent).toBe(true)
  await changing.refresh(); expect(changing.snapshot().status).toMatchObject({ phase: 'offline', code: 'HOST_OFFLINE' }); expect(changing.snapshot().link).toBeNull()
  await changing.refresh(); expect(changing.snapshot().link).toBe('https://relay.example/connect/one#key=new-owned-test'); expect(changing.snapshot().status.code).toBeUndefined()
  expect(listener).toHaveBeenCalledTimes(3)
})
test.each(['rotate', 'stop', 'configure', 'replace-registration', 'start'] as const)('explicit %s stays busy and serial while stale poll finishes', async action => {
  const poll = deferred<typeof ready>(), mutation = deferred<{ status: typeof ready.status; link: string | null }>(); const inputs: string[] = []
  const store = new ManagementStore(async input => { inputs.push(input.action); return input.action === 'status' ? poll.promise : mutation.promise })
  const polling = store.refresh()
  const input = action === 'configure' || action === 'replace-registration' ? { action, relayOrigin: 'https://relay.example', enrollmentSecret: 'A'.repeat(43) } : { action }
  const acting = store.run(input); expect(store.snapshot().busy).toBe(true); expect(inputs).toEqual(['status', action])
  await store.run({ action: 'stop' }); await store.refresh(); expect(inputs).toEqual(['status', action])
  mutation.resolve({ ...ready, link: null }); await acting; const settled = store.snapshot(); expect(settled.busy).toBe(false)
  poll.resolve(ready); await polling; expect(store.snapshot()).toBe(settled); expect(store.snapshot().link).toBeNull()
})
test('late polling failure cannot clear a newly rotated link', async () => {
  const poll = deferred<typeof ready>(), mutation = deferred<typeof ready>()
  const store = new ManagementStore(input => input.action === 'status' ? poll.promise : mutation.promise)
  const polling = store.refresh(), acting = store.run({ action: 'rotate' }); mutation.resolve({ ...ready, link: 'https://relay.example/connect/one#key=new' }); await acting
  poll.reject(new Error('stale failure')); await polling; expect(store.snapshot().link).toBe('https://relay.example/connect/one#key=new'); expect(store.snapshot().error).toBeUndefined()
})
test('close invalidates a pending poll and reopened refresh is independent of it', async () => {
  const old = deferred<typeof ready>(), reopened = deferred<typeof ready>(); let calls = 0
  const store = new ManagementStore(() => ++calls === 1 ? old.promise : reopened.promise)
  const closingPoll = store.refresh(); store.close(); const reopeningPoll = store.refresh(); expect(calls).toBe(2)
  reopened.resolve({ ...ready, link: 'https://relay.example/connect/one#key=reopened' }); await reopeningPoll
  const settled = store.snapshot(); old.resolve(ready); await closingPoll; expect(store.snapshot()).toBe(settled)
})
test('closing pending mutation clears presentation without releasing mutation serialization', async () => {
  const mutation = deferred<typeof ready>(); const inputs: string[] = []
  const store = new ManagementStore(input => { inputs.push(input.action); return mutation.promise })
  const acting = store.run({ action: 'start' }); store.close(); expect(store.snapshot()).toMatchObject({ busy: false, link: null })
  const second = store.run({ action: 'rotate' }), polling = store.refresh(); expect(inputs).toEqual(['start']); await second; await polling; expect(store.snapshot().busy).toBe(true)
  mutation.resolve(ready); await acting; expect(store.snapshot().link).toBeNull(); expect(store.snapshot().busy).toBe(false)
  await store.refresh(); expect(store.snapshot().link).toBe(ready.link)
})
test('background failure is visible, stable while retrying, and cleared only by actual success', async () => {
  const retry = deferred<typeof ready>(); let calls = 0
  const store = new ManagementStore(() => { calls++; if(calls === 1) return Promise.resolve(ready); if(calls < 4) return Promise.reject(new Error('RPC unavailable')); return retry.promise })
  await store.refresh(); await store.refresh(); expect(store.snapshot()).toMatchObject({ error: 'RPC unavailable', link: null, busy: false })
  const failed = store.snapshot(), listener = vi.fn(); store.subscribe(listener); await store.refresh(); expect(store.snapshot()).toBe(failed); expect(listener).not.toHaveBeenCalled()
  const polling = store.refresh(); expect(store.snapshot()).toBe(failed); retry.resolve(ready); await polling
  expect(store.snapshot().error).toBeUndefined(); expect(store.snapshot().link).toBe(ready.link); expect(listener).toHaveBeenCalledTimes(1)
})
