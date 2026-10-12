import { createElement as h, useEffect, useRef, useState } from 'react'
import type { ManagementStore } from './management-store.ts'
import { locales } from './locales.ts'
import { pairingConfigLimit, parsePairingConfig, type PairingConfig } from './pairing-config.ts'

export function PairingSetup({ store, language, paired, busy, onClose }: { store: ManagementStore; language: string; paired: boolean; busy: boolean; onClose(): void }) {
  const text = language.startsWith('zh') ? locales.zh : locales.en
  const [config, setConfig] = useState<PairingConfig | null>(null), [error, setError] = useState(''), [replace, setReplace] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null), revision = useRef(0)
  useEffect(() => () => { revision.current++ }, [])
  async function read(file?: File) {
    const current = ++revision.current
    setConfig(null); setError(''); setReplace(false)
    if (!file) return
    try {
      if (file.size > pairingConfigLimit) throw new Error('INVALID_CONNECTION_CONFIG')
      const next = parsePairingConfig(await file.text())
      if (revision.current === current) setConfig(next)
    } catch { if (revision.current === current) setError(text.invalidConfig) }
  }
  async function connect() {
    if (!config || busy) return
    const input = { action: replace ? 'replace-registration' as const : 'configure' as const, relayOrigin: config.relayOrigin, enrollmentSecret: config.enrollmentSecret }
    const current = ++revision.current
    setConfig(null); setReplace(false); setError('')
    if (fileInput.current) fileInput.current.value = ''
    await store.run(input)
    if (current !== revision.current) return
    const result = store.snapshot()
    if (result.error) setError(result.error === 'RELAY_REGISTRATION_REQUIRED' ? text.differentRelay : `${text.incomplete}: ${result.error}`)
    else if (result.status.phase === 'ready') onClose()
  }
  return h('section', { className: 'wc-setup', 'aria-label': text.setup },
    h('h3', null, text.setup), h('p', null, text.setupHelp),
    h('input', { ref: fileInput, hidden: true, type: 'file', accept: '.json,application/json', 'aria-label': text.importConfig, disabled: busy, onChange: event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; void read(file) } }),
    h('div', { className: 'wc-actions' }, h('button', { type: 'button', disabled: busy, onClick: () => fileInput.current?.click() }, text.importConfig),
      paired && h('button', { type: 'button', disabled: busy, onClick: () => { void read(); onClose() } }, text.cancel)),
    config && h('div', { className: 'wc-setup-review' }, h('p', null, text.connectTo, ' ', h('strong', null, config.relayOrigin)),
      paired && h('label', { className: 'wc-replace-choice' }, h('input', { type: 'checkbox', checked: replace, disabled: busy, onChange: event => setReplace(event.currentTarget.checked) }), text.replaceHelp),
      h('div', { className: 'wc-actions' }, h('button', { type: 'button', className: replace ? 'wc-danger' : 'wc-primary', disabled: busy, onClick: () => { void connect() } }, replace ? text.replace : text.pair))),
    error && h('p', { role: 'alert', className: 'wc-error' }, error))
}
