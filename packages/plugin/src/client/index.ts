import { createElement } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { ManagementRow } from './ManagementRow.tsx'
import { ManagementStore, type ManagementSnapshot } from './management-store.ts'
import { locales } from './locales.ts'
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'settings.web-control': 'nav' }
}
const NS = 'settings.web-control'
export const inject = ['slots', 'locale', 'connection']
/** This slot owns presentation only; closing/unmounting never invokes stop. */
export function apply(ctx: Context): void {
  const connection = ctx.get('connection') as unknown as ConnectionHandle
  const store = new ManagementStore(async input => {
    const result = await connection.rpc.call('/api', 'web-control/manage', { args: input })
    if (!result.ok) throw new Error('code' in result.error ? String(result.error.code) : 'INCOMPLETE')
    return result.value as Pick<ManagementSnapshot, 'status' | 'link'>
  })
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh: { nav: locales.zh.title }, en: { nav: locales.en.title } }))
  ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'web-control', order: 110, label: () => t('nav'), locale: NS },
    () => createElement(ManagementRow, { store, language: ctx.locale.getSnapshot().active })))
}
