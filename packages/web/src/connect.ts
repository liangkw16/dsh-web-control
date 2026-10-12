import { ERROR_CODES, ProtocolError, validateId, parseUiSelection, type UiSelection } from '../../protocol/src/index.ts'
export const AUTHORIZATION_HELP = 'Keep the original authorization link on your host. If this page reloads after a failed login or the cookie expires, open that link again.'
interface AuthorizationEnvironment { href: string; history: Pick<History, 'state' | 'replaceState'>; fetch: typeof fetch }
/** The link secret lives only in this page's closure, never in persistent storage. */
export class BrowserAuthorization {
  private readonly secret: string | null
  private readonly fetch: typeof fetch
  constructor(environment: AuthorizationEnvironment = { href: location.href, history, fetch: globalThis.fetch.bind(globalThis) }) {
    const url = new URL(environment.href)
    this.secret = new URLSearchParams(url.hash.slice(1)).get('key')
    url.hash = ''; environment.history.replaceState(environment.history.state, '', url)
    this.fetch = environment.fetch
  }
  get hasLink(): boolean { return !!this.secret }
  async authorize(instanceId: string, signal?: AbortSignal): Promise<void> {
    validateId(instanceId)
    if (!this.secret) throw new ProtocolError('AUTH_REQUIRED', AUTHORIZATION_HELP)
    const response = await this.fetch(`/v1/instances/${instanceId}/login`, { method: 'POST', credentials: 'same-origin', redirect: 'error', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ secret: this.secret }), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000) })
    if (!response.ok) throw await httpFailure(response)
  }
}

/** Upgrade rejection bodies are hidden by native WebSocket. This probe changes no lease/cookie. */
export async function controlStatus(instanceId: string, fetcher: typeof fetch = globalThis.fetch.bind(globalThis), signal?: AbortSignal): Promise<{ hostOnline: boolean; remoteConnected: boolean }> {
  validateId(instanceId)
  const response = await fetcher(`/v1/instances/${instanceId}/control-status`, { method: 'POST', credentials: 'same-origin', redirect: 'error', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000) })
  if (!response.ok) throw await httpFailure(response)
  const value = await response.json()
  if (!value || Object.keys(value).length !== 2 || typeof value.hostOnline !== 'boolean' || typeof value.remoteConnected !== 'boolean') throw new ProtocolError('INVALID_MESSAGE')
  return value
}

const AUTH_FAULTS = new Set(['AUTH_REQUIRED', 'AUTH_EXPIRED', 'AUTH_FAILED', 'AUTH_REVOKED', 'AUTH_EPOCH_CONFLICT'])
const HTTP_FAULTS = new Set<string>([...ERROR_CODES, ...AUTH_FAULTS, 'ORIGIN_DENIED', 'NOT_FOUND'])
/** A proxy/unknown error response cannot establish a missing or expired authorization. */
async function httpFailure(response: Response): Promise<ProtocolError> {
  try {
    const value = await response.json(); const code = value?.error?.code
    if (typeof code === 'string' && HTTP_FAULTS.has(code)) return new ProtocolError(code, AUTH_FAULTS.has(code) ? AUTHORIZATION_HELP : code)
  } catch { /* Do not show arbitrary proxy/server text, including non-JSON error bodies. */ }
  return new ProtocolError('HOST_OFFLINE', 'HTTP service unavailable', true)
}

/** Authenticated immutable UI selection; never creates or replaces a control lease. */
export async function readUiProfile(instanceId: string, fetcher: typeof fetch = globalThis.fetch.bind(globalThis), signal?: AbortSignal): Promise<UiSelection> {
  validateId(instanceId)
  const response = await fetcher(`/v1/instances/${instanceId}/ui-profile`, { credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000) })
  if (!response.ok) throw await httpFailure(response)
  return parseUiSelection(await response.json())
}
