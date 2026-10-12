/** Native UI gate: owned stock Host only. No desktop attach, production relay or user credential access. */
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, chmod, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { chromium, expect } from '@playwright/test';
import { collectUiArtifacts } from './native-ui-artifacts.mjs';
import { installNativeUiObserver } from './native-ui-observer.mjs';
import { startFixtureProxy } from './native-ui-fixture-proxy.mjs';
import { registerPublicProbe, publicProbeGraph, publicCompositionBoot } from './native-ui-public-probe.mjs';
import { cleanupNativeFixture } from './native-ui-cleanup.mjs';
import { stopOwned } from './owned-child.mjs';
import {validateNativeGateRuns} from './native-ui-gates.mjs';

const root = resolve(import.meta.dirname, '..');
const stage = process.argv[process.argv.indexOf('--stage') + 1];
if (['core','core-diagnostic','parity'].includes(stage)) {
  const child = spawn(process.execPath, [join(root, 'node_modules/@playwright/test/cli.js'), 'test', '--config', stage==='parity'?'tests/e2e/native-ui-parity.config.ts':'tests/e2e/native-ui.config.ts', ...(stage === 'core-diagnostic' ? [] : ['--max-failures=1'])], { cwd: root, stdio: ['ignore','pipe','inherit'], env: { ...process.env, NATIVE_UI_STAGE:stage, NATIVE_UI_DIAGNOSTIC: stage === 'core-diagnostic' ? '1' : '0' } });
  let output='';child.stdout.on('data',bytes=>{output+=bytes;process.stdout.write(bytes)});
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve)});
  const paths=output.split('\n').flatMap(line=>{try{const row=JSON.parse(line);return row.directory&&row.stage?[row.directory]:[]}catch{return[]}});
  const runs=await Promise.all(paths.map(async path=>JSON.parse(await readFile(join(path,'evidence.json'),'utf8'))));
  let valid=code===0;try{validateNativeGateRuns(stage==='parity'?'parity':'core',runs)}catch{valid=false}
  for(const run of runs){
    valid&&=run.status==='PASS'&&run.releaseGate==='PASS'&&run.csp.length===0&&run.browserErrors.length===0&&run.cleanup.sockets===0&&run.cleanup.hostExited&&run.cleanupErrors.length===0&&run.processes.every(p=>p.ended);
    for(const[path,expected]of Object.entries(run.sourceSha256))valid&&=createHash('sha256').update(await readFile(join(root,path))).digest('hex')===expected;
  }
  if(stage!=='core-diagnostic')await writeFile(join(root,`docs/native-ui-${stage}-result.json`),JSON.stringify({schema:1,status:valid?'PASS':'FAIL',task:stage==='parity'?6:5,desktop:'NOT_RUN',production:'NOT_RUN',runs},null,2));
  process.exit(stage!=='core-diagnostic'?(valid?0:1):code);
}
if (!['inventory', 'seams', 'composition', 'boundaries', 'lifetime'].includes(stage)) throw new Error('Implemented stages: inventory, seams, composition, boundaries, lifetime');
const runtime = join(root, 'data/compat/runtime-0.2.0-rc.2');
const stockNode = process.execPath;
const cli = join(runtime, 'node_modules/@deepseek-ai/dsh/lib/bin.js');
const pnpm = (process.env.WEB_CONTROL_PNPM_CLI ?? process.env.npm_execpath ?? join(root,'node_modules/pnpm/bin/pnpm.mjs'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
await mkdir(join(root, 'data/native-ui'), { recursive: true });
const dir = await mkdtemp(join(root, 'data/native-ui/inventory-'));
const home = join(dir, 'home'), bin = join(dir, 'bin'); await mkdir(home); await mkdir(bin);
await writeFile(join(bin, 'pnpm'), '#!/bin/sh\nexec '+stockNode+' '+pnpm+' "$@"\n'); await chmod(join(bin, 'pnpm'), 0o755);
const env = { PATH: bin + ':' + process.env.PATH, HOME: home, DSH_HOME: home, TMPDIR: process.env.TMPDIR, DSH_TELEMETRY_DISABLED: '1', NO_COLOR: '1', NPM_CONFIG_CACHE: join(dir, 'npm-cache'), XDG_CACHE_HOME: join(dir, 'cache') };
const evidence = { status: 'RUNNING', stage, startedAt: new Date().toISOString(), directory: dir, processes: [], checks: [], desktop: 'NOT_RUN', production: 'NOT_RUN' };
console.log(JSON.stringify({ directory: dir, stage }));
await writeFile(join(dir, 'evidence.json'), JSON.stringify(evidence, null, 2));
const secrets = [], logs = [];
let host, browser, cookie, origin, page, proxy, browserDeadline;
const errors = [], failures = [], consoles = [];
const check = (name, ok) => { evidence.checks.push({ name, ok }); if (!ok) throw new Error(name); };
const record = child => { const row = { pid: child.pid, executable: child.spawnfile, argv: child.spawnargs, startedAt: new Date().toISOString() }; evidence.processes.push(row); void writeFile(join(dir, 'running-processes.json'), JSON.stringify(evidence.processes)).catch(() => {}); child.once('close', (code, signal) => { row.endedAt = new Date().toISOString(); row.code = code; row.signal = signal; }); };
const run = async (command, args) => {
  const child = spawn(command, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] }); record(child);
  child.stdout.on('data', bytes => logs.push(String(bytes))); child.stderr.on('data', bytes => logs.push(String(bytes)));
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  if (code !== 0) throw new Error('Owned command failed: ' + args[0]);
};
const request = (url, init = {}) => fetch(url, { ...init, headers: { ...init.headers, cookie, origin }, signal: init.signal ?? AbortSignal.timeout(90000) });
try {
  const fixture = join(dir, 'fixture/package'); await mkdir(fixture, { recursive: true });
  const source = await readFile(join(root, 'packages/plugin/src/compat/native-ui-fixture.ts'), 'utf8');
  evidence.fixtureSha256 = sha(source); evidence.runnerSha256 = sha(await readFile(import.meta.filename));
  evidence.sourceSha256 = Object.fromEntries(await Promise.all(['scripts/native-ui-compat.mjs', 'scripts/native-ui-public-probe.mjs', 'scripts/native-ui-observer.mjs', 'scripts/native-ui-fixture-proxy.mjs', 'scripts/native-ui-cleanup.mjs', 'scripts/native-ui-artifacts.mjs', 'packages/plugin/src/compat/native-ui-fixture.ts'].map(async path => [path, sha(await readFile(join(root, path)))])));
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext } }).outputText;
  await writeFile(join(fixture, 'index.js'), compiled);
  await writeFile(join(fixture, 'package.json'), JSON.stringify({ name: 'web-control-native-ui-fixture', version: '0.0.0', type: 'module', main: './index.js', files: ['index.js', 'cordis.patch.yml'], dsh: { bundle: { patch: ['./cordis.patch.yml'] } }, peerDependencies: { '@deepseek-ai/cordis': '~4.0.4', '@deepseek-ai/dsh': '0.2.0-rc.2' } }));
  await writeFile(join(fixture, 'cordis.patch.yml'), '- insert:\n    - id: web-control-native-ui-fixture\n      name: web-control-native-ui-fixture\n');
  await run('/usr/bin/tar', ['-czf', join(dir, 'fixture.tgz'), '-C', join(dir, 'fixture'), 'package']);
  await run(stockNode, [cli, 'plugin', '--profile', 'web', 'add', join(dir, 'fixture.tgz')]);
  await writeFile(join(home, 'profiles/web/.web-control-compat.json'), JSON.stringify({ isolated: true, nativeUi: true }));
  host = spawn(stockNode, [cli, 'web', '--no-open', '--host', '127.0.0.1', '--port', '0'], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] }); record(host);
  const address = await new Promise((resolve, reject) => {
    let output = ''; const timer = setTimeout(() => reject(new Error('Stock Host startup timeout')), 90000);
    const consume = bytes => { output += bytes; const match = output.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/); if (match) { clearTimeout(timer); resolve(match[1]); } };
    host.stdout.on('data', consume); host.stderr.on('data', consume); host.once('exit', () => { clearTimeout(timer); logs.push(output); reject(new Error('Stock Host exited')); });
  });
  secrets.push(new URL(address).searchParams.get('token')); origin = new URL(address).origin;
  const login = await fetch(address, { redirect: 'manual' }); cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; '); secrets.push(cookie);
  const setupReply = await request(origin + '/api/web-control/native-ui/setup', { method: 'POST' });
  check('stock-fixture-setup', setupReply.ok); evidence.native = await setupReply.json();
  const manifest = await collectUiArtifacts({ runtimeRoot: runtime, outputDir: join(dir, 'artifacts'), fixtureOrigin: origin, fetch: request });
  evidence.artifacts = { count: manifest.assets.length, revision: manifest.revision, manifestSha256: sha(await readFile(join(dir, 'artifacts/manifest.json'))) };
  check('published-artifacts-verified', manifest.assets.length > 10);
  browser = await chromium.launch({ headless: true, env, args: ['--host-resolver-rules=MAP native-ui.test 127.0.0.1', '--no-proxy-server'], executablePath: process.env.WEB_CONTROL_CHROMIUM_EXECUTABLE });
  evidence.browser = { name: 'Chrome', version: browser.version() };
  browserDeadline = setTimeout(() => { evidence.timeout = true; void browser.close(); }, 120000);
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
  await context.addCookies(cookie.split('; ').map(part => { const index = part.indexOf('='); return { name: part.slice(0, index), value: part.slice(index + 1), url: origin }; }));
  await context.addInitScript(installNativeUiObserver, { denyQueueWrites: stage === 'boundaries' });
  if (stage !== 'inventory') {
    await run('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'proxy-key.pem'), '-out', join(dir, 'proxy-cert.pem'), '-days', '1', '-subj', '/CN=native-ui.test']);
    proxy = await startFixtureProxy({ upstream: origin, cookie, key: await readFile(join(dir, 'proxy-key.pem')), cert: await readFile(join(dir, 'proxy-cert.pem')) });
    await context.route('**/native-ui-public-probe.js', route => route.fulfill({ contentType: 'text/javascript', body: '(' + registerPublicProbe.toString() + ')(' + (['composition', 'boundaries', 'lifetime'].includes(stage)) + ',' + (stage === 'lifetime') + ');' }));
    await context.route(proxy.origin + '/', async route => {
      const reply = await request(origin + '/');
      const html = (await reply.text()).replace('</body>', '<script>' + 'globalThis.__nativeUiOwnRenderer=' + (stage === 'lifetime') + ';' + publicProbeGraph + (['composition', 'boundaries', 'lifetime'].includes(stage) ? publicCompositionBoot : '') + '</script></body>');
      await route.fulfill({ contentType: 'text/html', body: html });
    });
  }
  page = await context.newPage();
  page.on('console', message => { if (message.type() === 'error') consoles.push(message.text()); });
  page.on('pageerror', error => errors.push(error.message)); page.on('requestfailed', req => failures.push({ path: new URL(req.url()).pathname, reason: req.failure()?.errorText }));
  await page.goto(proxy?.origin ?? origin); await expect(page.getByText('Native UI verification', { exact: true }).first()).toBeVisible({ timeout: 30000 });
  await writeFile(join(dir, 'before-interaction.txt'), await page.locator('body').ariaSnapshot());
  await page.screenshot({ path: join(dir, 'before-interaction.png') });
  const preview = page.getByRole('dialog', { name: '预览版说明' });
  if (await preview.isVisible()) await preview.getByRole('button', { name: '继续', exact: true }).click();
  await page.getByRole('treeitem', { name: /Native UI verification/ }).click();
  await expect(page.getByText('Native UI seeded history', { exact: true })).toBeVisible({ timeout: 20000 });
  check('untouched-stock-ui-mount-and-history', true);
  await page.getByRole('button', { name: /^已完成/ }).click();
  const historicalTool = page.getByRole('button', { name: '已调用工具', exact: true });
  await expect(historicalTool).toBeVisible();
  await historicalTool.click();
  await page.getByRole('button', { name: /^工具调用 native_ui_history/ }).click();
  await expect(page.getByText('Native historical tool output', { exact: true })).toBeVisible();
  check('native-historical-tool-expanded', true);
  const input = page.getByRole('textbox', { name: /^(发消息或创建任务, \/ 调用指令, @ 文件或对话|Cmd\/Ctrl\+Enter 插话发送全部排队消息)$/ });
  await input.click(); await input.pressSequentially('Native UI synthetic prompt');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect.poll(async () => (await (await request(origin + '/api/web-control/native-ui/status')).json()).starts).toBe(1);
  await expect(page.getByRole('button', { name: '允许一次', exact: true })).toBeVisible({ timeout: 10000 });
  await writeFile(join(dir, 'approval-accessibility.txt'), await page.locator('body').ariaSnapshot());
  await page.getByRole('button', { name: '允许一次', exact: true }).click();
  await expect(page.getByText('Native UI fixture output', { exact: true })).toBeVisible();
  check('native-send-approval-stream', true);
  await writeFile(join(dir, 'running-accessibility.txt'), await page.locator('body').ariaSnapshot());
  await page.getByRole('button', { name: '停止生成', exact: true }).click();
  await expect.poll(async () => (await (await request(origin + '/api/web-control/native-ui/status')).json()).stops).toBe(1);
  check('native-explicit-stop', true);
  await page.locator('input[type=file]').setInputFiles({ name: 'native-ui-upload.txt', mimeType: 'text/plain', buffer: Buffer.from('Synthetic attachment\n') });
  await expect(page.getByText('native-ui-upload.txt', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeEnabled({ timeout: 10000 });
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByRole('button', { name: '允许一次', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '允许一次', exact: true }).click();
  await expect.poll(async () => (await (await request(origin + '/api/web-control/native-ui/status')).json()).approvals).toBe(2);
  await page.getByRole('button', { name: '停止生成', exact: true }).click();
  await expect.poll(async () => (await (await request(origin + '/api/web-control/native-ui/status')).json()).stops).toBe(2);
  check('native-file-upload-send-stop', true);
  if (stage !== 'inventory') {
    await expect.poll(() => page.evaluate(() => !!globalThis.__nativeUiPublicProbe)).toBe(true);
    const preferenceReply = await request(origin + '/api/web-control/native-ui/preference', { method: 'POST' });
    check('host-preference-reads-actual-view', preferenceReply.ok);
    const view = await preferenceReply.json();
    check('host-preference-is-steer', view.value?.busyEnter === 'steer');
    evidence.preferenceProbe = await page.evaluate(view => globalThis.__nativeUiPublicProbe.tryPublicSeed(view), view);
    check('real-nonloopback-authority', evidence.preferenceProbe.before.isLoopback === false);
    evidence.preferenceSupported = evidence.preferenceProbe.afterSet.busyEnter === 'steer';
    if (['composition', 'boundaries', 'lifetime'].includes(stage)) {
      evidence.composition = await page.evaluate(view => globalThis.__nativeUiPublicProbe.composeReadOnlyPreference(view), view);
      check('public-composition-adopts-actual-preference', evidence.composition.busyEnter === 'steer');
      evidence.preferenceSupported = true;
    }
    await input.click(); await input.pressSequentially('Native preference comparison');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect(page.getByRole('button', { name: '允许一次', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '允许一次', exact: true }).click();
    await expect(page.getByRole('button', { name: '停止生成', exact: true })).toBeVisible();
    await input.click(); await input.pressSequentially('Unsent preference draft');
    const remoteBusyLabel = ['composition', 'boundaries', 'lifetime'].includes(stage) ? '插话发送' : '排队发送';
    await expect(page.getByRole('button', { name: remoteBusyLabel, exact: true })).toBeVisible();
    evidence.remoteBusySendLabel = remoteBusyLabel;
    await page.screenshot({ path: join(dir, 'remote-preference-gap.png') });
    if (stage === 'boundaries') {
      await input.press('Meta+A'); await input.press('Backspace');
      await input.pressSequentially('Native queued message');
      await input.press('Meta+Enter');
      const edit = page.getByRole('button', { name: '编辑排队消息', exact: true });
      await expect(edit).toBeEnabled();
      evidence.queueBoundary = { editEnabled: await edit.isEnabled() };
      await page.evaluate(sessionId => globalThis.__nativeUiPublicProbe.setComposerBlock(sessionId, true), evidence.native.sessionId);
      await expect(page.getByRole('textbox', { name: 'Queue editing unavailable', exact: true })).toBeDisabled();
      evidence.queueBoundary.blockDisablesEditor = true;
      evidence.queueBoundary.editEnabledWhileBlocked = await edit.isEnabled();
      await page.screenshot({ path: join(dir, 'queue-block.png') });
      await page.evaluate(sessionId => globalThis.__nativeUiPublicProbe.setComposerBlock(sessionId, false), evidence.native.sessionId);
      await page.evaluate(() => globalThis.__nativeUiPublicProbe.hideQueueDock());
      await expect(edit).toHaveCount(0);
      await expect(input).toBeEditable();
      await input.click(); await input.press('Meta+Enter');
      await expect.poll(() => page.evaluate(() => globalThis.__nativeUiInventory.denied.length)).toBe(1);
      evidence.queueBoundary.shortcutAttemptsAfterDockHidden = await page.evaluate(() => globalThis.__nativeUiInventory.denied.length);
      evidence.queueBoundary.forwardedQueueWrites = proxy.requests.filter(row => row.path === '/api/session/updateQueue').length;
      check('excluded-queue-write-not-forwarded', evidence.queueBoundary.forwardedQueueWrites === 0);
      await writeFile(join(dir, 'queue-boundary-accessibility.txt'), await page.locator('body').ariaSnapshot());
    }
    const localPage = await context.newPage();
    await localPage.goto(origin);
    const localPreview = localPage.getByRole('dialog', { name: '预览版说明' });
    await expect(localPreview).toBeVisible({ timeout: 10000 });
    await localPreview.getByRole('button', { name: '继续', exact: true }).click();
    await expect(localPage.getByRole('treeitem', { name: /Native UI verification/ })).toBeVisible({ timeout: 15000 });
    await localPage.getByRole('treeitem', { name: /Native UI verification/ }).click();
    const localInput = localPage.getByRole('textbox', { name: /^(发消息或创建任务, \/ 调用指令, @ 文件或对话|Cmd\/Ctrl\+Enter 插话发送全部排队消息)$/ });
    await localInput.click(); await localInput.pressSequentially('Unsent preference draft');
    // The queue row has its own steer button; the native composer follows that list.
    await expect(localPage.getByRole('button', { name: '插话发送', exact: true }).last()).toBeVisible();
    evidence.localBusySendLabel = '插话发送';
    await localPage.screenshot({ path: join(dir, 'local-preference-steer.png') });
    await localInput.press('Meta+A'); await localInput.press('Backspace');
    if (stage !== 'lifetime') {
      await localPage.getByRole('button', { name: '停止生成', exact: true }).click();
      await expect.poll(async () => (await (await request(origin + '/api/web-control/native-ui/status')).json()).stops).toBe(3);
    }
    await localPage.close();
    check(['composition', 'boundaries', 'lifetime'].includes(stage) ? 'busy-send-preference-matches' : 'busy-send-preference-difference-reproduced', true);
  }

  await page.screenshot({ path: join(dir, 'stock-ui.png') });
  await writeFile(join(dir, 'ui-accessibility.txt'), await page.locator('body').ariaSnapshot());
  await writeFile(join(dir, 'observations.json'), JSON.stringify(await page.evaluate(() => globalThis.__nativeUiInventory.observations), null, 2));
  evidence.browserErrors = errors; evidence.requestFailures = failures; evidence.consoleErrors = consoles; evidence.proxyRequests = proxy?.requests;
  check('stock-ui-no-uncaught-errors', errors.length === 0);
  if (stage === 'lifetime') {
    const before = await (await request(origin + '/api/web-control/native-ui/status')).json();
    check('task-still-running-before-unmount', before.starts === 3 && before.stops === 2);
    evidence.uiLifetime = await page.evaluate(() => globalThis.__nativeUiPublicProbe.unmount());
    check('native-root-mounted-and-unmounted-once', evidence.uiLifetime.mounts === 1 && evidence.uiLifetime.unmounts === 1);
    await expect(input).toHaveCount(0);
    const after = await (await request(origin + '/api/web-control/native-ui/status')).json();
    check('unmount-causes-no-business-action', JSON.stringify(before) === JSON.stringify(after));
    evidence.uiLifetime.businessBefore = before; evidence.uiLifetime.businessAfter = after;
  }
  await context.close(); check('stock-ui-context-disposed', true);
  check('no-uncaught-errors-through-unmount', errors.length === 0);
  evidence.status = evidence.preferenceSupported === false || evidence.queueBoundary?.shortcutAttemptsAfterDockHidden ? 'BLOCKED' : 'PASS';
} catch (error) {
  evidence.status = 'FAIL'; evidence.error = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) if (secret) evidence.error = evidence.error.split(secret).join('[REDACTED]');
  console.error(evidence.error.split('\n')[0]);
  if (page && !page.isClosed()) {
    evidence.compositionDiagnostics = await page.evaluate(() => globalThis.__nativeUiPublicProbe?.diagnostics()).catch(() => undefined);
    await writeFile(join(dir, 'failure-accessibility.txt'), await page.locator('body').ariaSnapshot()).catch(() => {});
    await page.screenshot({ path: join(dir, 'failure.png') }).catch(() => {});
    await writeFile(join(dir, 'observations.json'), JSON.stringify(await page.evaluate(() => globalThis.__nativeUiInventory?.observations), null, 2)).catch(() => {});
  }
  evidence.browserErrors = errors; evidence.requestFailures = failures; evidence.consoleErrors = consoles; evidence.proxyRequests = proxy?.requests;
} finally {
  clearTimeout(browserDeadline);
  const cleanup = await cleanupNativeFixture({ browser: () => browser?.close() ?? Promise.resolve(), proxy: () => proxy?.close() ?? Promise.resolve(), host: () => stopOwned(host), key: () => unlink(join(dir, 'proxy-key.pem')).catch(error => { if (error.code !== 'ENOENT') throw error; }) });
  evidence.cleanup = { browserClosed: cleanup.browserClosed, hostExited: cleanup.hostExited };
  evidence.proxyCleanup = cleanup.proxyCleanup; evidence.cleanupErrors = cleanup.errors;
  if (cleanup.errors.length) evidence.status = 'FAIL';
  evidence.finishedAt = new Date().toISOString();
  for (const row of evidence.processes) row.awaitedAt = evidence.finishedAt;
  await writeFile(join(dir, 'evidence.json'), JSON.stringify(evidence, null, 2));
  let log = logs.join('\n'); for (const secret of secrets) if (secret) log = log.split(secret).join('[REDACTED]');
  await writeFile(join(dir, 'log.txt'), log);
  console.log(JSON.stringify({ status: evidence.status, directory: dir }));
  if (evidence.status !== 'PASS') process.exitCode = 1;
}
