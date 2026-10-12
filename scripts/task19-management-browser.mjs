/** Owned actual-component polling reproduction; no stock/production profile access. */
import { createServer } from 'vite'
import { chromium } from '@playwright/test'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
const root = resolve(import.meta.dirname, '..')
const startedAt=new Date().toISOString()
const mode = process.argv[2] ?? 'green', dir = join(root, 'data/task19/component-' + mode)
await mkdir(dir, { recursive: true })
await writeFile(join(dir, 'fixture.tsx'), `
import React from 'react';import{createRoot}from'react-dom/client';
import{ManagementRow}from'/packages/plugin/src/client/ManagementRow.tsx';
import{ManagementStore}from'/packages/plugin/src/client/management-store.ts';
const metrics=window.metrics={calls:0,notifications:0,disabled:[],canvasDraws:0,frames:0,nodeChanges:0,geometryChanges:0,mutations:0};
const draw=CanvasRenderingContext2D.prototype.putImageData;CanvasRenderingContext2D.prototype.putImageData=function(...args){metrics.canvasDraws++;return draw.apply(this,args)};
const result={status:{phase:'ready',instanceId:'owned-synthetic',controllerPresent:false},link:'https://relay.example/connect/owned-synthetic#key=owned-fixture-only'};
const store=new ManagementStore(async()=>{metrics.calls++;await new Promise(resolve=>setTimeout(resolve,350));return structuredClone(result)});window.store=store;store.subscribe(()=>metrics.notifications++);
createRoot(document.getElementById('root')).render(React.createElement(ManagementRow,{store}));
window.startMetrics=()=>{let nodes,geometry;const observer=new MutationObserver(records=>{metrics.mutations+=records.length;for(const record of records)if(record.attributeName==='disabled'){const n=record.target;metrics.disabled.push({text:n.textContent,disabled:n.disabled,opacity:getComputedStyle(n).opacity})}});observer.observe(document.querySelector('.wc-panel'),{subtree:true,childList:true,attributes:true,characterData:true});const sample=()=>{const panel=document.querySelector('.wc-panel'),canvas=panel?.querySelector('canvas');const now=[panel,canvas];if(nodes&&now.some((n,i)=>n!==nodes[i]))metrics.nodeChanges++;nodes=now;const rects=now.map(n=>{const r=n.getBoundingClientRect();return[r.x,r.y,r.width,r.height]});const g=JSON.stringify(rects);if(geometry&&g!==geometry)metrics.geometryChanges++;geometry=g;metrics.frames++;window.frame=requestAnimationFrame(sample)};sample();};
`)
await writeFile(join(dir, 'index.html'), '<div id="root"></div><script type="module" src="./fixture.tsx"></script>')
const server = await createServer({ root, configFile: false, server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' })
let browser
try {
  await server.listen(); const address = server.httpServer.address()
  browser = await chromium.launch({ headless: true, executablePath: process.env.WEB_CONTROL_CHROMIUM_EXECUTABLE })
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  await page.goto(`http://127.0.0.1:${address.port}/data/task19/component-${mode}/index.html`)
  await page.getByRole('button', { name: 'Manage Web Control', exact: true }).click()
  await page.locator('canvas').waitFor()
  await page.waitForFunction(() => !window.store.snapshot().busy && window.metrics.canvasDraws === 1)
  await page.evaluate(() => window.startMetrics())
  const initial = await page.evaluate(() => ({ ...window.metrics, disabled: [...window.metrics.disabled] }))
  await page.waitForFunction(() => window.metrics.calls >= 4 && !window.store.snapshot().busy)
  const final = await page.evaluate(() => {cancelAnimationFrame(window.frame);return window.metrics})
  const sourceSha256=createHash('sha256').update(await readFile(join(root,'packages/plugin/src/client/management-store.ts'))).digest('hex')
  const evidence = { mode, startedAt, finishedAt:new Date().toISOString(), sourceSha256, browser: browser.version(), startedAfterInitial: initial, final, polls: final.calls-initial.calls, unchangedNotifications:final.notifications-initial.notifications, stablePanelAndCanvas:final.nodeChanges===0, stableGeometry:final.geometryChanges===0, canvasRepaints:final.canvasDraws-initial.canvasDraws }
  await writeFile(join(dir, 'evidence.json'), JSON.stringify(evidence, null, 2)+'\n')
  await page.screenshot({ path: join(dir, 'management-1280.png') })
  await page.setViewportSize({ width: 390, height: 900 });await page.screenshot({ path: join(dir, 'management-390.png') })
  assert(evidence.polls>=3);assert(evidence.stablePanelAndCanvas);assert(evidence.stableGeometry);assert.equal(evidence.canvasRepaints,0)
  if(mode==='red'){assert.equal(evidence.unchangedNotifications,9);assert.equal(final.disabled.filter(x=>x.disabled&&x.opacity==='0.45').length,6)}
  else{assert.equal(evidence.unchangedNotifications,0);assert.equal(final.disabled.length,0);assert.equal(final.mutations,0)}
  console.log(JSON.stringify(evidence))
} finally {await browser?.close();await server.close()}
