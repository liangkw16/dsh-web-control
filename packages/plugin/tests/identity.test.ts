import { createHash } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { credentialKey, type CredentialKey, type CredentialProvider, type CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { DEFAULT_LIMITS, parseHandshake } from '../../protocol/src/index.ts'
import { IdentityManager } from '../src/identity.ts'
import { DshCredentialStore, MemoryCredentialStore, profileCredentialKey } from '../src/credential-store.ts'

const scope = createHash('sha256').update('/task-owned/profile-web').digest('hex')
const otherScope = createHash('sha256').update('/task-owned/profile-desktop').digest('hex')
const origin = 'https://control.example.com'

// Task-owned public-service fixture: the same async atomic callback and no-op
// semantics as CredentialProvider. It never opens a DSH profile or application.
class PublicServiceFixture implements Pick<CredentialProvider, 'readRecord' | 'modifyRecord'> {
  records = new Map<CredentialKey, CredentialRecord>()
  keys: CredentialKey[] = []
  writes = 0
  failNextWrite = false
  failRead = false
  private tail = Promise.resolve()
  async readRecord(key: CredentialKey) {
    if (this.failRead) throw new Error('private provider diagnostic')
    return structuredClone(this.records.get(key))
  }
  async modifyRecord(key: CredentialKey, mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>) {
    this.keys.push(key)
    const before = this.tail
    let unlock!: () => void
    this.tail = new Promise<void>(resolve => { unlock = resolve })
    await before
    try {
      const next = await mutate(structuredClone(this.records.get(key)))
      if (next !== undefined) {
        if (this.failNextWrite) { this.failNextWrite = false; throw new Error('private write diagnostic') }
        this.records.set(key, structuredClone(next))
        this.writes++
      }
      return structuredClone(this.records.get(key))
    } finally { unlock() }
  }
}

for (const kind of ['memory', 'public service'] as const) {
  describe(kind, () => {
    function setup() {
      const service = new PublicServiceFixture()
      const store = kind === 'memory' ? new MemoryCredentialStore() : new DshCredentialStore(service)
      return { service, store, manager: new IdentityManager(store, scope), failWrite() {
        if (store instanceof MemoryCredentialStore) store.failNextWrite = true
        else service.failNextWrite = true
      } }
    }

    test('restart preserves the identity and enabled link', async () => {
      const { store, manager } = setup()
      const first = await manager.enable(origin)
      expect(first.instanceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
      for (const value of [first.deviceSecret, first.linkSecret]) {
        expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/)
        expect(Buffer.from(value, 'base64url')).toHaveLength(32)
      }
      expect(first.deviceSecret).not.toBe(first.linkSecret)
      // Matches the relay's CHECK(auth_epoch >= 1) registration contract.
      expect(first.authEpoch).toBe(1)
      const registration = { v: 1, type: 'host.hello', instanceId: first.instanceId,
        runtimeId: '00000000-0000-4000-8000-000000000001', versions: [1], capabilities: [],
        authEpoch: first.authEpoch, linkVerifier: createHash('sha256').update(first.linkSecret).digest('hex'), enabled: first.enabled }
      expect(parseHandshake(JSON.stringify(registration), DEFAULT_LIMITS)).toEqual(registration)
      expect(await new IdentityManager(store, scope).load()).toEqual(first)
      expect(await new IdentityManager(store, scope).enable(origin)).toEqual(first)
    })

    test('different profile hashes own different credentials', async () => {
      const { store, manager } = setup()
      const a = await manager.enable(origin)
      const b = await new IdentityManager(store, otherScope).enable(origin)
      expect(a.instanceId).not.toBe(b.instanceId)
      expect(a.deviceSecret).not.toBe(b.deviceSecret)
      expect(a.linkSecret).not.toBe(b.linkSecret)
      expect(await manager.load()).toEqual(a)
    })

    test('stop survives restart and enable replaces the link', async () => {
      const { store, manager } = setup()
      const first = await manager.enable(origin)
      const stopped = await manager.stop()
      expect(stopped).toEqual({ ...first, enabled: false, authEpoch: 2 })
      const restarted = new IdentityManager(store, scope)
      expect(await restarted.load()).toEqual(stopped)
      const enabled = await restarted.enable(origin)
      expect(enabled).toEqual({ ...first, linkSecret: enabled.linkSecret, authEpoch: 3 })
      expect(enabled.linkSecret).not.toBe(first.linkSecret)
    })

    test('concurrent rotations increment from the current committed record', async () => {
      const { store, manager } = setup()
      const first = await manager.enable(origin)
      const results = await Promise.all([manager.rotate(), new IdentityManager(store, scope).rotate()])
      expect(results.map(value => value.authEpoch)).toEqual([2, 3])
      expect(new Set([first.linkSecret, ...results.map(value => value.linkSecret)]).size).toBe(3)
      expect(results.every(value => value.instanceId === first.instanceId && value.deviceSecret === first.deviceSecret)).toBe(true)
      expect(await manager.load()).toEqual(results[1])
    })

    test.each(['rotate', 'stop'] as const)('failed %s never publishes uncommitted state and releases the lock', async method => {
      const { manager, failWrite } = setup()
      const first = await manager.enable(origin)
      failWrite()
      await expect(manager[method]()).rejects.toThrow('WRITE_FAILED')
      expect(await manager.load()).toEqual(first)
      expect((await manager.rotate()).authEpoch).toBe(2)
    })

    test('a failed concurrent rotation cannot consume an epoch or block the next update', async () => {
      const { manager, failWrite } = setup()
      const original = await manager.enable(origin)
      failWrite()
      const [failed, passed] = await Promise.allSettled([manager.rotate(), manager.rotate()])
      expect(failed.status).toBe('rejected')
      if (failed.status === 'rejected') expect(failed.reason.message).toContain('WRITE_FAILED')
      expect(passed.status).toBe('fulfilled')
      if (passed.status === 'fulfilled') {
        expect(passed.value.authEpoch).toBe(2)
        expect(passed.value.deviceSecret).toBe(original.deviceSecret)
        expect(await manager.load()).toEqual(passed.value)
      }
    })

    test('concurrent first enables create only one stable registration', async () => {
      const { manager, store } = setup()
      const results = await Promise.all([manager.enable(origin), new IdentityManager(store, scope).enable(origin)])
      expect(results[0]).toEqual(results[1])
      expect(results[0].authEpoch).toBe(1)
    })

    test('failed initial enable and failed re-enable preserve prior state', async () => {
      const { manager, failWrite } = setup()
      failWrite()
      await expect(manager.enable(origin)).rejects.toThrow('WRITE_FAILED')
      expect(await manager.load()).toBeUndefined()
      await manager.enable(origin)
      const stopped = await manager.stop()
      failWrite()
      await expect(manager.enable(origin)).rejects.toThrow('WRITE_FAILED')
      expect(await manager.load()).toEqual(stopped)
    })

    test('changed relay origin requires explicit local registration even after stop', async () => {
      const { manager } = setup()
      const first = await manager.enable(origin)
      await expect(manager.enable('https://another.example.com')).rejects.toThrow('RELAY_REGISTRATION_REQUIRED')
      expect(await manager.load()).toEqual(first)
      const stopped = await manager.stop()
      await expect(manager.enable('https://another.example.com')).rejects.toThrow('RELAY_REGISTRATION_REQUIRED')
      expect(await manager.load()).toEqual(stopped)
    })

    test('normalizes equivalent origins and rejects non-origin URLs', async () => {
      const { manager } = setup()
      const first = await manager.enable('https://CONTROL.example.com:443/')
      expect(first.relayOrigin).toBe(origin)
      expect(await manager.enable(origin)).toEqual(first)
      for (const invalid of ['https://user:pass@example.com', origin + '/path', origin + '/path/..', origin + '/?', origin + '/#',
        origin + '?x=1', origin + '#x', 'http://localhost:8080', 'file:///tmp', 'not a URL', ' ' + origin, origin + '\\']) {
        await expect(manager.enable(invalid)).rejects.toThrow('INVALID_RELAY_ORIGIN')
      }
      expect(await manager.load()).toEqual(first)
    })

    test('load and callback results cannot mutate the committed identity', async () => {
      const { store, manager } = setup()
      const first = await manager.enable(origin)
      const original = { ...first }
      first.authEpoch = 900
      const read = (await manager.load())!
      read.linkSecret = 'bad'
      await expect(store.update(scope, old => { old!.authEpoch = 99; throw new Error('aborted') })).rejects.toThrow()
      expect(await manager.load()).toEqual(original)
    })

    test('invalid callback output cannot commit over valid credentials', async () => {
      const { manager, store } = setup()
      const original = await manager.enable(origin)
      await expect(store.update(scope, old => ({ ...old!, enabled: 'true' as unknown as boolean }))).rejects.toThrow('IDENTITY_CORRUPT')
      expect(await manager.load()).toEqual(original)
      await expect(store.update(scope, old => ({ ...old!, authEpoch: 0 }))).rejects.toThrow('IDENTITY_CORRUPT')
      expect(await manager.load()).toEqual(original)
    })

    test('missing identity and invalid scopes fail explicitly', async () => {
      const { store, manager } = setup()
      expect(await manager.load()).toBeUndefined()
      await expect(manager.rotate()).rejects.toThrow('IDENTITY_MISSING')
      await expect(manager.stop()).rejects.toThrow('IDENTITY_MISSING')
      for (const invalid of ['', '/real/profile', 'profile-web', scope.toUpperCase()]) {
        await expect(store.read(invalid)).rejects.toThrow('INVALID_PROFILE_SCOPE')
        await expect(store.update(invalid, () => { throw new Error('must not execute') })).rejects.toThrow('INVALID_PROFILE_SCOPE')
      }
    })

    test('epoch exhaustion cannot wrap or commit an unsafe integer', async () => {
      const { manager, store } = setup()
      await manager.enable(origin)
      const last = await store.update(scope, old => ({ ...old!, authEpoch: Number.MAX_SAFE_INTEGER }))
      await expect(manager.rotate()).rejects.toThrow('AUTH_EPOCH_EXHAUSTED')
      await expect(manager.stop()).rejects.toThrow('AUTH_EPOCH_EXHAUSTED')
      expect(await manager.load()).toEqual(last)
    })

    test('rotation while disabled never enables control', async () => {
      const { manager } = setup()
      await manager.enable(origin)
      const stopped = await manager.stop()
      const rotated = await manager.rotate()
      expect(rotated.enabled).toBe(false)
      expect(rotated.authEpoch).toBe(stopped.authEpoch + 1)
      expect(rotated.linkSecret).not.toBe(stopped.linkSecret)
    })
  })
}

describe('public record format', () => {
  test('maps supplied profile hash to a valid alphabetic credential key with versioned payload', async () => {
    const service = new PublicServiceFixture()
    const store = new DshCredentialStore(service)
    const identity = await new IdentityManager(store, scope).enable(origin)
    const expected = credentialKey('web-control', 'profile-' + [...scope].map(char => 'abcdefghijklmnop'[parseInt(char, 16)]).join(''))
    expect(profileCredentialKey(scope)).toBe(expected)
    expect(profileCredentialKey(otherScope)).not.toBe(expected)
    expect(service.keys).toEqual([expected])
    expect(service.records.get(expected)).toEqual({ kind: 'grant', payload: { schemaVersion: 1, ...identity } })
    expect(JSON.stringify(service.records.get(expected))).not.toContain('/task-owned/profile-web')
    await new IdentityManager(store, scope).enable(origin)
    expect(service.writes).toBe(1) // undefined means preserve, never delete.
  })

  test('provider read errors are sanitized and cannot appear as absence', async () => {
    const service = new PublicServiceFixture()
    service.failRead = true
    await expect(new IdentityManager(new DshCredentialStore(service), scope).load()).rejects.toThrow('READ_FAILED')
  })

  test.each([
    null,
    {},
    { kind: 'api-key' },
    { kind: 'grant', payload: null },
    { kind: 'grant', payload: {} },
  ])('preserves malformed existing record %# and fails with repair guidance', async record => {
    const service = new PublicServiceFixture()
    const key = profileCredentialKey(scope)
    service.records.set(key, record as CredentialRecord)
    const manager = new IdentityManager(new DshCredentialStore(service), scope)
    for (const operation of [() => manager.load(), () => manager.enable(origin), () => manager.rotate(), () => manager.stop()]) {
      await expect(operation()).rejects.toThrow(/IDENTITY_CORRUPT.*repair/i)
      expect(service.records.get(key)).toEqual(record)
    }
    expect(service.writes).toBe(0)
  })

  test('validates every stored field and schema version before enabling or updating', async () => {
    const service = new PublicServiceFixture()
    const manager = new IdentityManager(new DshCredentialStore(service), scope)
    const original = await manager.enable(origin)
    const valid = { schemaVersion: 1, ...original }
    const patches: Record<string, unknown>[] = [
      { schemaVersion: 0 }, { schemaVersion: 2 }, { instanceId: 'not-a-uuid' },
      { deviceSecret: '' }, { linkSecret: 'x'.repeat(43) }, { authEpoch: 0 }, { authEpoch: -1 }, { authEpoch: 1.5 },
      { authEpoch: Number.MAX_SAFE_INTEGER + 1 }, { enabled: 'true' },
      { relayOrigin: origin + '/path' }, { unexpected: true },
    ]
    const key = profileCredentialKey(scope)
    for (const patch of patches) {
      const record: CredentialRecord = { kind: 'grant', payload: { ...valid, ...patch } }
      service.records.set(key, record)
      await expect(manager.load()).rejects.toThrow('IDENTITY_CORRUPT')
      await expect(manager.enable(origin)).rejects.toThrow('IDENTITY_CORRUPT')
      expect(service.records.get(key)).toEqual(record)
    }
    for (const field of Object.keys(valid)) {
      const payload = { ...valid } as Record<string, unknown>
      delete payload[field]
      service.records.set(key, { kind: 'grant', payload })
      await expect(manager.rotate()).rejects.toThrow('IDENTITY_CORRUPT')
    }
  })

  test('update validates caller output before the public service commits it', async () => {
    const service = new PublicServiceFixture()
    const store = new DshCredentialStore(service)
    const manager = new IdentityManager(store, scope)
    const original = await manager.enable(origin)
    await expect(store.update(scope, old => ({ ...old!, authEpoch: NaN }))).rejects.toThrow('IDENTITY_CORRUPT')
    expect(await manager.load()).toEqual(original)
  })
})
