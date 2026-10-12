import { credentialKey, type CredentialKey, type CredentialProvider, type CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { ProtocolError } from '../../protocol/src/index.ts'
import { corruptIdentity, validateIdentity, validateProfileScope, type Identity } from './identity.ts'

export interface CredentialStore {
  read(scope: string): Promise<Identity | undefined>
  update(scope: string, change: (old: Identity | undefined) => Identity): Promise<Identity>
}

/** Injective nibble encoding of the already supplied canonical-profile hash. */
export function profileCredentialKey(scope: string): CredentialKey {
  validateProfileScope(scope)
  const alphabeticHash = [...scope].map(char => 'abcdefghijklmnop'[parseInt(char, 16)]).join('')
  return credentialKey('web-control', 'profile-' + alphabeticHash)
}

function decodeRecord(record: CredentialRecord | undefined): Identity | undefined {
  if (record === undefined) return undefined
  if (!record || typeof record !== 'object' || Object.getPrototypeOf(record) !== Object.prototype) corruptIdentity()
  const kind = Object.getOwnPropertyDescriptor(record, 'kind')
  const storedPayload = Object.getOwnPropertyDescriptor(record, 'payload')
  if (!kind?.enumerable || !Object.hasOwn(kind, 'value') || kind.value !== 'grant'
    || !storedPayload?.enumerable || !Object.hasOwn(storedPayload, 'value')) corruptIdentity()
  const payload: unknown = storedPayload.value
  if (!payload || typeof payload !== 'object' || Object.getPrototypeOf(payload) !== Object.prototype) corruptIdentity()
  const version = Object.getOwnPropertyDescriptor(payload, 'schemaVersion')
  if (!version?.enumerable || !Object.hasOwn(version, 'value') || version.value !== 1) corruptIdentity()
  // Inspect descriptors before copying: malformed/accessor records must stay intact.
  for (const field of Reflect.ownKeys(payload)) {
    const descriptor = Object.getOwnPropertyDescriptor(payload, field)!
    if (typeof field !== 'string' || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) corruptIdentity()
  }
  const { schemaVersion: _, ...identity } = payload as Record<string, unknown>
  return validateIdentity(identity)
}

function sameIdentity(a: Identity | undefined, b: Identity): boolean {
  // Both inputs are validated and have the same canonical property order.
  return a !== undefined && JSON.stringify(a) === JSON.stringify(b)
}

/** Production adapter uses only the published credential service's atomic seam. */
export class DshCredentialStore implements CredentialStore {
  constructor(private readonly provider: Pick<CredentialProvider, 'readRecord' | 'modifyRecord'>) {}

  async read(scope: string): Promise<Identity | undefined> {
    const key = profileCredentialKey(scope)
    let record: CredentialRecord | undefined
    try { record = await this.provider.readRecord(key) }
    catch { throw new ProtocolError('READ_FAILED', 'Unable to read the local control identity.', true) }
    return decodeRecord(record)
  }

  async update(scope: string, change: (old: Identity | undefined) => Identity): Promise<Identity> {
    const key = profileCredentialKey(scope)
    let mutationFailed = false
    let mutationError: unknown
    let committed: CredentialRecord | undefined
    try {
      committed = await this.provider.modifyRecord(key, async record => {
        try {
          const old = decodeRecord(record)
          const next = validateIdentity(change(old === undefined ? undefined : { ...old }))
          // undefined is the public API's no-op; deletion is never a transition.
          return sameIdentity(old, next) ? undefined : { kind: 'grant', payload: { schemaVersion: 1, ...next } }
        } catch (error) { mutationFailed = true; mutationError = error; throw error }
      })
    } catch {
      if (mutationFailed) throw mutationError
      // No provider diagnostics/paths/credential values escape through this error.
      throw new ProtocolError('WRITE_FAILED', 'Unable to commit the local control identity.', true)
    }
    const identity = decodeRecord(committed)
    if (!identity) throw new ProtocolError('WRITE_FAILED', 'Credential provider returned no committed identity.', true)
    return identity
  }
}

/** Contract-equivalent test store: per-profile serialization, detached values, atomic failures. */
export class MemoryCredentialStore implements CredentialStore {
  failNextWrite = false
  private readonly identities = new Map<string, Identity>()
  private readonly pending = new Map<string, Promise<void>>()

  async read(scope: string): Promise<Identity | undefined> {
    validateProfileScope(scope)
    const value = this.identities.get(scope)
    return value === undefined ? undefined : validateIdentity(value)
  }

  async update(scope: string, change: (old: Identity | undefined) => Identity): Promise<Identity> {
    validateProfileScope(scope)
    const before = this.pending.get(scope) ?? Promise.resolve()
    let unlock!: () => void
    const tail = new Promise<void>(resolve => { unlock = resolve })
    this.pending.set(scope, tail)
    await before
    try {
      const old = await this.read(scope)
      const next = validateIdentity(change(old === undefined ? undefined : { ...old }))
      if (!sameIdentity(old, next)) {
        if (this.failNextWrite) {
          this.failNextWrite = false
          throw new ProtocolError('WRITE_FAILED', 'Unable to commit the local control identity.', true)
        }
        this.identities.set(scope, { ...next })
      }
      return { ...next }
    } finally {
      unlock()
      if (this.pending.get(scope) === tail) this.pending.delete(scope)
    }
  }
}
