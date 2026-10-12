import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test, vi } from 'vitest'
import { ManagementRow } from '../src/client/ManagementRow.tsx'
import { ManagementStore } from '../src/client/management-store.ts'

// The shipped component is client-only. Supply the same snapshot during this
// static render; browser interaction coverage runs the unmodified React hooks.
vi.mock('react', async original => {
  const react = await original<typeof import('react')>()
  return { ...react, useSyncExternalStore: (subscribe: Parameters<typeof react.useSyncExternalStore>[0], snapshot: () => unknown) => react.useSyncExternalStore(subscribe, snapshot, snapshot) }
})

test('paired settings offer control without exposing deployment credential fields', async () => {
  const store = new ManagementStore(async () => ({ status: { phase: 'ready', instanceId: 'owned', controllerPresent: false }, link: 'https://relay.example/connect/owned#key=fixture' }))
  await store.refresh()
  const html = renderToStaticMarkup(createElement(ManagementRow, { store, language: 'zh' }))
  expect(html).toContain('复制链接')
  expect(html).not.toContain('type="password"')
  expect(html).not.toContain('type="url"')
})

test('a stopped paired device can be enabled without reentering deployment settings', async () => {
  const store = new ManagementStore(async () => ({ status: { phase: 'disabled', instanceId: 'owned', controllerPresent: false }, link: null }))
  await store.refresh()
  const html = renderToStaticMarkup(createElement(ManagementRow, { store, language: 'zh' }))
  expect(html).toContain('启用远控')
  expect(html).not.toContain('type="password"')
})

test('a new device starts with configuration import rather than manual credentials', () => {
  const store = new ManagementStore(async () => ({ status: { phase: 'disabled', instanceId: null, controllerPresent: false }, link: null }))
  const html = renderToStaticMarkup(createElement(ManagementRow, { store, language: 'zh' }))
  expect(html).toContain('导入连接配置')
  expect(html).not.toContain('type="password"')
})
