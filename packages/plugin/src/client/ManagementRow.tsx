import { createElement as h, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import QRCode from 'qrcode'
import type { ManagementStore } from './management-store.ts'
import { locales } from './locales.ts'
import { managementStyles } from './management-styles.ts'
import { PairingSetup } from './PairingSetup.tsx'
export function ManagementRow({ store, language = 'en' }: { store: ManagementStore; language?: string }) {
  const text = language.startsWith('zh') ? locales.zh : locales.en
  const state = useSyncExternalStore(store.subscribe, store.snapshot)
  const [setupOpen, setSetupOpen] = useState(false), [feedback, setFeedback] = useState('')
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    void store.refresh(); const timer = setInterval(() => { void store.refresh() }, 2000)
    // The stock settings shell mounts only its selected section. Leaving it
    // releases private presentation and polls, without changing Host lifetime.
    return () => { clearInterval(timer); store.close() }
  }, [store])
  useEffect(() => { if (state.link && canvas.current) void QRCode.toCanvas(canvas.current, state.link, { width: 240, margin: 2 }).catch(() => {}) }, [state.link])
  useEffect(() => { setFeedback('') }, [state.link])
  const paired = !!state.status.instanceId
  const needsSetup = !paired || state.status.code === 'AUTH_FAILED' || state.status.code === 'AUTH_REVOKED'
  const icon = h('svg', { viewBox: '0 0 24 24', width: 24, height: 24, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, 'aria-hidden': true }, h('rect', { x: 2, y: 3, width: 15, height: 12, rx: 2 }), h('path', { d: 'M7 19h5M9.5 15v4' }), h('rect', { x: 16, y: 10, width: 6, height: 11, rx: 1.5 }))
  return h('div', { 'data-web-control-management': true },
    h('style', null, managementStyles),
      h('section', { className: 'wc-panel', 'aria-label': text.title },
        h('header', { className: 'wc-heading' }, h('span', { className: 'wc-icon' }, icon), h('div', null, h('h2', null, text.title), h('p', null, text.purpose))),
        h('div', { className: 'wc-status' }, h('span', { className: `wc-dot wc-${state.status.phase}`, 'aria-hidden': true }), h('output', { 'aria-live': 'polite' }, text.phase[state.status.phase]), h('span', { className: 'wc-status-note' }, state.status.controllerPresent ? text.connected : state.status.phase === 'ready' ? text.waiting : paired ? text.saved : text.notPaired)),
        state.link && h('section', { className: 'wc-connect' }, h('h3', null, text.scan), h('p', null, text.scanHelp),
          h('div', { className: 'wc-qr' }, h('canvas', { ref: canvas, role: 'img', 'aria-label': text.qr })),
          h('p', { className: 'wc-narrow-help' }, text.narrowHelp),
          h('div', { className: 'wc-link-actions' }, h('button', { type: 'button', className: 'wc-primary', onClick: async () => { try { await navigator.clipboard.writeText(state.link!); setFeedback(text.copied) } catch { setFeedback(text.copyFailed) } } }, feedback === text.copied ? '✓ ' + text.copied : text.copy), h('a', { href: state.link, target: '_blank', rel: 'noreferrer', className: 'wc-button' }, text.openLink)),
          h('input', { className: 'wc-link', readOnly: true, value: state.link, 'aria-label': text.copy, onFocus: event => event.currentTarget.select() }), h('p', { className: 'wc-feedback', role: 'status' }, feedback || text.linkHelp)),
        (needsSetup || setupOpen) && h(PairingSetup, { store, language, paired, busy: state.busy, onClose: () => setSetupOpen(false) }),
        paired && h('div', { className: 'wc-secondary' },
          state.status.phase === 'disabled' ? h('button', { type: 'button', className: 'wc-primary', disabled: state.busy, onClick: () => { void store.run({ action: 'resume' }) } }, text.enable)
            : h('button', { type: 'button', disabled: state.busy || state.status.phase !== 'ready', onClick: () => { void store.run({ action: 'rotate' }) } }, text.renew),
          (state.status.phase === 'offline' || state.status.phase === 'error') && h('button', { type: 'button', disabled: state.busy, onClick: () => { void store.run({ action: 'start' }) } }, text.retry),
          state.status.phase !== 'disabled' && h('button', { className: 'wc-danger', type: 'button', disabled: state.busy, onClick: () => { void store.run({ action: 'stop' }) } }, text.stop)),
        paired && !needsSetup && !setupOpen && h('button', { type: 'button', className: 'wc-settings-link', disabled: state.busy, onClick: () => setSetupOpen(true) }, text.changeConnection),
        state.error && h('p', { className: 'wc-error', role: 'alert' }, state.error === 'RELAY_REGISTRATION_REQUIRED' ? text.differentRelay : `${text.incomplete}: ${state.error}`),
        h('footer', null, h('p', null, text.enabled), h('p', null, text.preview))))
}
