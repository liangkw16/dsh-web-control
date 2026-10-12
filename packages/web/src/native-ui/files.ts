import { parseCurrentFileStat, ProtocolError } from '../../../protocol/src/index.ts'
import type { BrowserTransport } from '../transport.ts'

export function downloadName(path: string): string {
  return path.split(/[\\/]/).at(-1)?.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_').replace(/^\.+$/, '_').slice(0, 240) || 'download'
}
function saveBlob(blob: Blob, name: string): () => void {
  const url = URL.createObjectURL(blob), anchor = document.createElement('a')
  anchor.href = url; anchor.download = downloadName(name); anchor.rel = 'noopener'; document.body.append(anchor)
  try { anchor.click() } finally { anchor.remove() }
  const release = () => { clearTimeout(timer); URL.revokeObjectURL(url) }
  const timer = setTimeout(release, 30000)
  return release
}
interface Entry { owners: number; pending?: AbortController; error: boolean; releases: Set<() => void> }
/** Shared between the stock toolbar and empty-state seats for the same file. */
export class NativeDownloads {
  private entries = new Map<string, Entry>()
  private listeners = new Set<() => void>()
  private releases = new Set<() => void>()
  private revision = 0
  private fence: string
  private unsubscribe: () => void
  constructor(private readonly transport: Pick<BrowserTransport, 'call' | 'download' | 'getSnapshot' | 'subscribe'>, private readonly save = saveBlob) {
    this.fence = JSON.stringify(transport.getSnapshot().fence)
    this.unsubscribe = transport.subscribe(() => {
      const state = transport.getSnapshot(), fence = JSON.stringify(state.fence)
      if (state.phase !== 'ready' || fence !== this.fence) { this.fence = fence; this.cancel(); this.changed() }
    })
  }
  key(sessionId: string, path: string): string { return JSON.stringify([sessionId, path]) }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  getSnapshot = () => this.revision
  state(key: string) { const entry = this.entries.get(key); return { pending: !!entry?.pending, error: !!entry?.error } }
  retain(key: string): () => void {
    const entry = this.entries.get(key) ?? { owners: 0, error: false, releases: new Set<() => void>() }; entry.owners++; this.entries.set(key, entry)
    return () => { if (--entry.owners === 0) { entry.pending?.abort(); for (const release of entry.releases) release(); this.entries.delete(key) } }
  }
  async start(sessionId: string, path: string): Promise<void> {
    const key = this.key(sessionId, path), entry = this.entries.get(key)
    if (!entry || entry.pending || this.transport.getSnapshot().phase !== 'ready') return
    const pending = new AbortController(); entry.pending = pending; entry.error = false; this.changed()
    try {
      const stat = parseCurrentFileStat(await this.transport.call({ op: 'file.stat', sessionId, path }, pending.signal))
      pending.signal.throwIfAborted(); if (!stat.ok) throw new ProtocolError('TRANSFER_CLOSED')
      const result = await this.transport.download(sessionId, stat.value.relativePath, pending.signal, stat.value.version)
      pending.signal.throwIfAborted()
      if (this.releases.size >= 8) { const oldest = this.releases.values().next().value!; oldest(); this.releases.delete(oldest) }
      const saved = this.save(result.blob, downloadName(result.name))
      const release = () => { saved(); entry.releases.delete(release); this.releases.delete(release) }
      entry.releases.add(release); this.releases.add(release)
    } catch { if (!pending.signal.aborted) entry.error = true }
    finally { if (entry.pending === pending) { entry.pending = undefined; this.changed() } }
  }
  private changed() { this.revision++; for (const listener of this.listeners) listener() }
  private cancel() { for (const entry of this.entries.values()) { entry.pending?.abort(); entry.pending = undefined }; for (const release of this.releases) release(); this.releases.clear() }
  dispose() { this.unsubscribe(); this.cancel(); this.entries.clear(); this.listeners.clear() }
}

/** One download action, composed into public stock seats. No preview renderer. */
export async function registerNativeFiles(ctx: any, require: (id: string) => any, transport: BrowserTransport, enabled: boolean): Promise<void> {
  if (!enabled) return
  const { installNativeMedia } = await import('./media-install.ts')
  const media = await installNativeMedia(transport)
  ctx.effect(() => () => media.dispose())
  // rc.2 interactive HTML needs arbitrary inline scripts inside its iframe.
  // Select the stock sanitized, opaque static viewer through a local public
  // configForms scope; preserve the desktop and other remote developer tools.
  const forms=ctx.configForms,scope=ctx.isolate('configForms')
  const provider=scope.plugin({name:'remote-static-document-preview',apply(owner:any){owner.provide('configForms',{
    get:(name:string)=>forms.get(name),describe:()=>forms.describe(),whileServed:(name:string,register:unknown)=>forms.whileServed(name,register),
    developerTools:{...forms.developerTools,enabled:{getSnapshot:()=>false,subscribe:()=>()=>{}}},
  })}})
  await provider.await()
  const preview=scope.plugin(ctx.loader.unwrapExports(require('@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client')))
  await preview.await();if(preview.state!==2)throw new Error('Native document preview unavailable')
  ctx.effect(()=>()=>preview.dispose())
  const React = require('react'), { Button } = require('@deepseek-ai/dsh-client-ui-primitives'), downloads = new NativeDownloads(transport)
  ctx.effect(() => () => downloads.dispose())
  const Download = ({ sessionId, absolutePath, t }: any) => {
    const key = downloads.key(sessionId, absolutePath)
    React.useEffect(() => downloads.retain(key), [key])
    React.useLayoutEffect(() => media.media.retain(sessionId, absolutePath), [key])
    React.useSyncExternalStore(downloads.subscribe, downloads.getSnapshot, downloads.getSnapshot)
    const state = downloads.state(key)
    return React.createElement(Button, { size: 'sm', style:{flexShrink:0}, disabled: state.pending, title:state.error?t('downloadFailed'):undefined, onClick: () => { void downloads.start(sessionId, absolutePath) }, 'aria-label': t('downloadFile') },
      state.error?React.createElement('span',{role:'status'},t('downloadRetry')):t(state.pending ? 'downloadingFile' : 'downloadFile'))
  }
  for (const name of ['sidebar.right.tab.document.actions', 'sidebar.right.tab.document.unpreviewable']) {
    ctx.effect(() => ctx.slots.inject(name, () => ctx.slots.register({ name, id: 'remote-file-download', locale: 'webControl' }, Download)))
  }
}
