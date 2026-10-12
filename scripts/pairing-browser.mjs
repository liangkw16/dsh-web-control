/** Actual management components in an owned browser. No user profile or Relay. */
import { createServer } from 'vite'
import { chromium, webkit, expect } from '@playwright/test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
const root = resolve(import.meta.dirname, '..'), dir = await mkdtemp(join(root, 'data/pairing-browser-'))
await writeFile(join(dir, 'index.html'), '<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="./fixture.tsx"></script>')
await writeFile(join(dir, 'fixture.tsx'), `
import React from 'react'; import {createRoot} from 'react-dom/client';
import {ManagementRow} from '/packages/plugin/src/client/ManagementRow.tsx';
import {ManagementStore} from '/packages/plugin/src/client/management-store.ts';
const phase=new URL(location.href).searchParams.get('phase')||'ready';
const ready={status:{phase:'ready',instanceId:'owned',controllerPresent:false},link:'https://relay.example/connect/owned#key=synthetic-fixture-only'};
let state=phase==='ready'?ready:phase==='error'?{status:{phase:'error',instanceId:'owned',controllerPresent:false,code:'AUTH_FAILED'},link:null}:{status:{phase:'disabled',instanceId:phase==='disabled'?'owned':null,controllerPresent:false},link:null};
window.actions=[];window.draws=0;
const draw=CanvasRenderingContext2D.prototype.putImageData;CanvasRenderingContext2D.prototype.putImageData=function(...args){window.draws++;return draw.apply(this,args)};
const store=new ManagementStore(async input=>{window.actions.push(input);if(['configure','replace-registration','resume'].includes(input.action))state=ready;if(input.action==='stop')state={status:{phase:'disabled',instanceId:'owned',controllerPresent:false},link:null};return structuredClone(state)});
window.store=store;createRoot(document.getElementById('root')).render(React.createElement(ManagementRow,{store,language:'zh'}));
`)
const server = await createServer({ root, configFile: false, server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' })
const results = [], config = { kind: 'dsh-web-control-connection', version: 1, relayOrigin: 'https://relay.example', enrollmentSecret: 'A'.repeat(43) }
let browser
try {
  await server.listen()
  const url = `http://127.0.0.1:${server.httpServer.address().port}/${dir.slice(root.length + 1)}/index.html`
  for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]]) {
    browser = await engine.launch(name === 'chromium' ? { headless: true, executablePath: process.env.WEB_CONTROL_CHROMIUM_EXECUTABLE } : { headless: true })
    const page = await browser.newPage({ viewport: { width: 1100, height: 950 } }), errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(url)
    await expect(page.getByRole('button', { name: '复制链接', exact: true })).toBeVisible()
    await expect(page.locator('input[type="password"],input[type="url"]')).toHaveCount(0)
    await expect(page.getByRole('button', { name: '导入连接配置' })).toHaveCount(0)
    await page.waitForFunction(() => window.draws === 1)
    await page.evaluate(async () => { window.originalCanvas = document.querySelector('canvas'); for (let i = 0; i < 4; i++) await window.store.refresh() })
    expect(await page.evaluate(() => window.draws === 1 && document.querySelector('canvas') === window.originalCanvas)).toBe(true)
    await page.screenshot({ path: join(dir, `${name}-paired.png`) })
    await page.setViewportSize({ width: 390, height: 900 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: join(dir, `${name}-narrow.png`) })
    await page.getByRole('button', { name: '更改连接', exact: true }).click()
    const upload = () => page.locator('input[type="file"]')
    await upload().setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from('{bad secret}') })
    await expect(page.getByRole('alert')).toContainText('连接配置无效')
    expect(await page.evaluate(() => window.actions.every(input => input.action === 'status'))).toBe(true)
    await upload().setInputFiles({ name: 'connection.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(config)) })
    await expect(page.getByText('即将连接')).toBeVisible()
    expect(await page.locator('body').innerText()).not.toContain(config.enrollmentSecret)
    await expect(page.getByRole('checkbox')).not.toBeChecked()
    await page.getByRole('button', { name: '取消', exact: true }).click()
    await expect(upload()).toHaveCount(0)
    expect(await page.evaluate(() => window.actions.every(input => input.action === 'status'))).toBe(true)
    await page.getByRole('button', { name: '停止远控', exact: true }).click()
    await expect(page.getByRole('button', { name: '启用远控', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '启用远控', exact: true }).click()
    await expect(page.getByRole('button', { name: '复制链接', exact: true })).toBeVisible()
    expect(await page.evaluate(() => window.actions.filter(input => input.action !== 'status').map(input => input.action))).toEqual(['stop', 'resume'])
    await page.goto(url + '?phase=new')
    await expect(page.getByRole('button', { name: '导入连接配置' })).toBeVisible()
    await upload().setInputFiles({ name: 'connection.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(config)) })
    await expect(page.getByRole('button', { name: '连接', exact: true })).toBeVisible()
    expect(await page.evaluate(() => window.actions.every(input => input.action === 'status'))).toBe(true)
    await page.getByRole('button', { name: '连接', exact: true }).click()
    await expect(page.getByRole('button', { name: '复制链接', exact: true })).toBeVisible()
    expect(await page.evaluate(() => window.actions.filter(input => input.action !== 'status'))).toEqual([{ action: 'configure', relayOrigin: config.relayOrigin, enrollmentSecret: config.enrollmentSecret }])
    await expect(upload()).toHaveCount(0)
    await page.getByRole('button', { name: '更改连接', exact: true }).click()
    await upload().setInputFiles({ name: 'connection.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(config)) })
    await page.getByRole('checkbox').check()
    await page.getByRole('button', { name: '重新配对', exact: true }).click()
    await expect(upload()).toHaveCount(0)
    expect(await page.evaluate(() => window.actions.filter(input => input.action !== 'status').at(-1).action)).toBe('replace-registration')
    await page.goto(url + '?phase=error')
    await expect(page.getByRole('button', { name: '导入连接配置' })).toBeVisible()
    await upload().setInputFiles({ name: 'connection.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(config)) })
    await expect(page.getByText('即将连接')).toBeVisible()
    await page.getByRole('button', { name: '取消', exact: true }).click()
    await expect(page.getByText('即将连接')).toHaveCount(0)
    expect(await page.evaluate(() => window.actions.every(input => input.action === 'status'))).toBe(true)
    expect(errors).toEqual([])
    results.push({ browser: name, status: 'PASS', ready: true, responsive: true, stableQr: true, invalidFile: true, explicitPairing: true, resume: true, explicitReplacement: true, errors })
    await browser.close(); browser = undefined
  }
  await writeFile(join(dir, 'result.json'), JSON.stringify({ status: 'PASS', results }, null, 2))
  console.log(JSON.stringify({ directory: dir, results }))
} finally { await browser?.close(); await server.close() }
