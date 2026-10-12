import { expect, test } from 'vitest'
import { RC2_UI_PROFILE, NATIVE_UI_MARKER, type HostUiProfile } from '../../protocol/src/ui-profile.ts'
import { selectUiProfile, type UiRelease } from '../src/ui-profiles.ts'
import { fixture, hello, runtimeId, instanceId } from './socket-fixture.ts'
const releases = [{ dshVersion: '0.2.0-rc.2', adapter: 'rc2-native-1', revision: 'a'.repeat(64) }]
test('selection requires exact Host version, capabilities, runtime and immutable resource revision', () => {
  expect(selectUiProfile(null, runtimeId, [])).toEqual({ kind: 'legacy', runtimeId })
  expect(selectUiProfile(RC2_UI_PROFILE, runtimeId, releases)).toEqual({ kind: 'native', profile: { host: RC2_UI_PROFILE, runtimeId, uiRevision: releases[0].revision } })
  for (const [host, runtime, available] of [[RC2_UI_PROFILE, runtimeId, []], [RC2_UI_PROFILE, 'runtime-a', releases], [{ ...RC2_UI_PROFILE, capabilities: [] }, runtimeId, releases], [RC2_UI_PROFILE, runtimeId, [{ ...releases[0], adapter: 'next' }]]] as [HostUiProfile, string, readonly UiRelease[]][]) expect(selectUiProfile(host, runtime, available)).toEqual({ kind: 'unavailable', code: 'PROTOCOL_UNSUPPORTED' })
})
test('authenticated profile lookup has no side effects, is not cached and describes offline/legacy/native facts', async () => {
  const f = await fixture({ nativeUiReleases: releases })
  try {
    await f.register(); const cookie = await f.login(); const url = f.http() + `/v1/instances/${instanceId}/ui-profile`
    expect((await fetch(url)).status).toBe(401)
    const get = () => fetch(url, { headers: { Cookie: cookie } })
    expect(await (await get()).json()).toEqual({ kind: 'unavailable', code: 'HOST_OFFLINE' })
    const h = await f.host({ ...hello, capabilities: [...RC2_UI_PROFILE.capabilities, NATIVE_UI_MARKER] }); await h.next('relay.ack')
    const response = await get(); expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({ kind: 'native', profile: { host: RC2_UI_PROFILE, runtimeId, uiRevision: releases[0].revision } })
    expect(h.messages.some(m => m.type === 'attach')).toBe(false)
    const legacy = await f.attach(h, cookie)
    legacy.b.send({ v: 1, type: 'heartbeat', fence: legacy.fence })
  } finally { await f.close() }
})
test('missing native assets rejects negotiated takeover before disturbing an existing lease', async () => {
  const f = await fixture()
  try {
    await f.register(); const h = await f.host({ ...hello, capabilities: [...RC2_UI_PROFILE.capabilities, NATIVE_UI_MARKER] }); await h.next('relay.ack')
    const cookie = await f.login(), first = await f.attach(h, cookie)
    const next = f.socket(`/v1/instances/${instanceId}/control`, { Cookie: cookie, Origin: f.config.publicOrigin }); await next.open()
    next.send({ v: 1, type: 'browser.hello', versions: [1], uiApi: 1, takeover: true })
    expect((await next.next('fault')).error.code).toBe('PROTOCOL_UNSUPPORTED')
    first.b.send({ v: 1, type: 'call', id: crypto.randomUUID(), fence: first.fence, command: { op: 'session.list', workspaceId: 'w' } })
    expect((await h.next('call')).fence).toEqual(first.fence)
    expect(first.b.messages.some(m => m.type === 'fault')).toBe(false)
    expect(h.messages.some(m => m.type === 'detach')).toBe(false)
  } finally { await f.close() }
})
test('only negotiated native client receives uiProfile in ready; legacy ready remains byte-shape compatible', async () => {
  const f = await fixture({ nativeUiReleases: releases })
  try {
    await f.register(); const h = await f.host({ ...hello, capabilities: [...RC2_UI_PROFILE.capabilities, NATIVE_UI_MARKER] }); await h.next('relay.ack'); const cookie = await f.login()
    for (const native of [false, true]) {
      const b = f.socket(`/v1/instances/${instanceId}/control`, { Cookie: cookie, Origin: f.config.publicOrigin }); await b.open()
      b.send({ v: 1, type: 'browser.hello', versions: [1], takeover: true, ...(native ? { uiApi: 1 } : {}) })
      const lease = await b.next('browser.lease'); b.send({ v: 1, type: 'browser.lease-ack', id: lease.id })
      const attach = await h.next('attach'); h.send({ v: 1, type: 'host.attached', id: attach.id, fence: attach.fence })
      expect(await b.next('ready')).toEqual({ v: 1, type: 'ready', fence: attach.fence, ...(native ? { uiProfile: { host: RC2_UI_PROFILE, runtimeId, uiRevision: releases[0].revision } } : {}) })
    }
  } finally { await f.close() }
})
test('legacy profile is authenticated and a native-only handshake cannot claim it', async () => {
  const f = await fixture({ nativeUiReleases: releases })
  try {
    await f.register(); const h = await f.host(); await h.next('relay.ack'); const cookie = await f.login()
    expect(await (await fetch(f.http() + `/v1/instances/${instanceId}/ui-profile`, { headers: { Cookie: cookie } })).json()).toEqual({ kind: 'legacy', runtimeId })
    const b = f.socket(`/v1/instances/${instanceId}/control`, { Cookie: cookie, Origin: f.config.publicOrigin }); await b.open()
    b.send({ v: 1, type: 'browser.hello', versions: [1], takeover: true, uiApi: 1 })
    expect((await b.next('fault')).error.code).toBe('PROTOCOL_UNSUPPORTED')
    expect(h.messages.some(m => m.type === 'attach')).toBe(false)
  } finally { await f.close() }
})
test('partial and unknown native capability markers fail closed without registering a Host', async () => {
  for (const capabilities of [[NATIVE_UI_MARKER], [...RC2_UI_PROFILE.capabilities, 'native-ui/rc3/1']]) {
    const f = await fixture()
    try {
      await f.register(); const h = await f.host({ ...hello, capabilities })
      expect((await h.next('fault')).error.code).toBe('PROTOCOL_UNSUPPORTED')
      const cookie = await f.login()
      expect(await (await fetch(f.http() + `/v1/instances/${instanceId}/ui-profile`, { headers: { Cookie: cookie } })).json()).toEqual({ kind: 'unavailable', code: 'HOST_OFFLINE' })
    } finally { await f.close() }
  }
})
