import { ProtocolError, validateId } from '@dsh-web-control/protocol'
import { SESSION_LIFETIME_MS, validateSecret } from './auth.ts'

/** Browser writes and upgrades require exactly the configured, canonical HTTPS origin. */
export function assertOrigin(origin: string | undefined, publicOrigin: string): void {
  const canonical = (value: unknown): value is string => {
    if (typeof value !== 'string' || !/^https:\/\/[^\s\\/@?#]+$/.test(value)) return false
    try { return new URL(value).origin === value } catch { return false }
  }
  if (!canonical(publicOrigin) || !canonical(origin) || origin !== publicOrigin) throw new ProtocolError('ORIGIN_DENIED')
}

export function cookieName(instanceId: string): string {
  validateId(instanceId)
  return `__Host-dshc-${instanceId}`
}

/** Set only after a fresh login; no Domain attribute is permitted for __Host- cookies. */
export function sessionCookie(instanceId: string, sessionToken: string): string {
  const name = cookieName(instanceId)
  validateSecret(sessionToken)
  return `${name}=${sessionToken}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${SESSION_LIFETIME_MS / 1000}`
}
