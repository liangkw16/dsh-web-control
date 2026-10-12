export function sha256(bytes: string | Uint8Array): string
export function safeErrorMessage(error: unknown): string
export function scopeFor(kind: string, name: string): string
export const coverage: Record<string, string[]>
export const nativeRequired: string[]
export const lifecycleRequired: string[]
export const freshScope: string
export function exact(value: unknown, keys: string[]): boolean
export interface CandidateIdentity {
  source: string
  dirty: boolean
  buildInputs: { algorithm: string; digest: string; files: number }
  pluginSha256: string
  relaySha256: string
  imageLockSha256: string
  imageReference: string
}
export function candidateIdentity(report: { artifacts: Array<{ path: string; sha256: string }>; versions: Record<string, string>; source: string }, base: string): Promise<CandidateIdentity>
export function validateReceipt(path: string, kind: string, name: string, report: { versions: Record<string, string>; environment: string; generatedAt: string }, identity: CandidateIdentity, base: string, check?: { command: string; exitCode: number; startedAt: string; finishedAt: string; log: string }): Promise<{ coveredBy: string[]; finishedAt: string; files: Array<{role: string; path: string; sha256: string}> }>

export const freshBrowserCases: { file: string; title: string }[]

export const publicRequired: string[]
