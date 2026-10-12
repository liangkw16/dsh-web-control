import type { Context } from '@deepseek-ai/cordis'
import { ProtocolError } from '../../protocol/src/index.ts'
import { normalizeRelayOrigin, type IdentityManager } from './identity.ts'
import { failureCode, type ControlLifecycle } from './lifecycle.ts'
import type { ManageInput } from './client/management-store.ts'
export function parseManage(value: unknown): ManageInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProtocolError('INVALID_MESSAGE')
  const input = value as Record<string, unknown>
  if (!['replace-registration', 'configure', 'resume', 'start', 'stop', 'rotate', 'status', 'link'].includes(String(input.action))) throw new ProtocolError('INVALID_MESSAGE')
  const allowed = ['configure', 'replace-registration'].includes(String(input.action)) ? ['action', 'relayOrigin', 'enrollmentSecret'] : ['action']
  if (Object.keys(input).some(key => !allowed.includes(key))) throw new ProtocolError('INVALID_MESSAGE')
  if (input.action === 'configure' || input.action === 'replace-registration') {
    if (typeof input.relayOrigin !== 'string' || (input.enrollmentSecret !== undefined && (typeof input.enrollmentSecret !== 'string' || input.enrollmentSecret.length > 4096))) throw new ProtocolError('INVALID_MESSAGE')
    if (input.action === 'replace-registration' && (typeof input.enrollmentSecret !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input.enrollmentSecret))) throw new ProtocolError('INVALID_MESSAGE')
    return { action: input.action, relayOrigin: normalizeRelayOrigin(input.relayOrigin), ...(input.enrollmentSecret === undefined ? {} : { enrollmentSecret: input.enrollmentSecret as string }) }
  }
  return { action: input.action } as ManageInput
}
/** Ordinary connection.fetch admission enforces Host/Origin/cookie. No remote passthrough exists. */
export function registerManagement(ctx: Context, ready: Promise<{ identity: IdentityManager; lifecycle: ControlLifecycle; enroll(secret: string, identity?: import('./identity.ts').Identity): Promise<void> }>): void {
  ctx.connection.fetch.register({ path: '/api/web-control/manage', methods: ['POST'], requestBody: 'buffered', async fetch(request) {
    let rpcId = ''
    try {
      const text = await request.text(); if (Buffer.byteLength(text) > 8192) throw new ProtocolError('LIMIT_EXCEEDED')
      const message = JSON.parse(text)
      if (message.type !== 'client-request' || typeof message.rpcId !== 'string' || message.rpcId.length > 128 || message.method !== 'web-control/manage') throw new ProtocolError('INVALID_MESSAGE')
      rpcId = message.rpcId
      const input = parseManage(message.payload?.args)
      const owner = await ready
      if (input.action === 'replace-registration') {
        await owner.lifecycle.replaceRegistration(input.relayOrigin, input.enrollmentSecret!, (identity, secret) => owner.enroll(secret, identity))
      } else if (input.action === 'resume') {
        await owner.lifecycle.configure(undefined, undefined, (identity, secret) => owner.enroll(secret, identity))
      } else if (input.action === 'configure') {
        await owner.lifecycle.configure(input.relayOrigin, input.enrollmentSecret, (identity, secret) => owner.enroll(secret, identity))
      } else if (input.action !== 'status' && input.action !== 'link') await owner.lifecycle[input.action]()
      return Response.json({ type: 'server-response', rpcId, result: { ok: true, value: { status: owner.lifecycle.status(), link: owner.lifecycle.link() } } })
    } catch (error) {
      const code = failureCode(error)
      return Response.json({ type: 'server-response', rpcId, result: { ok: false, error: { code, message: code, retryable: false } } })
    }
  } })
}
