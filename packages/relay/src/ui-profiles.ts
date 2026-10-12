import { parseHostUiProfile, parseUiSelection, type HostUiProfile, type UiSelection } from '@dsh-web-control/protocol'
export interface UiRelease { dshVersion: string; adapter: string; revision: string }
/** Available releases are supplied by the verified release manifest, never a request parameter. */
export function selectUiProfile(host: HostUiProfile | null, runtimeId: string, available: readonly UiRelease[]): UiSelection {
  try {
    if (!host) return parseUiSelection({ kind: 'legacy', runtimeId })
    const profile = parseHostUiProfile(host)
    const matches = available.filter(r => r.dshVersion === profile.dshVersion && r.adapter === profile.adapter)
    if (matches.length !== 1) return { kind: 'unavailable', code: 'PROTOCOL_UNSUPPORTED' }
    return parseUiSelection({ kind: 'native', profile: { host: profile, runtimeId, uiRevision: matches[0].revision } })
  } catch { return { kind: 'unavailable', code: 'PROTOCOL_UNSUPPORTED' } }
}
