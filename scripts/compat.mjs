import { stopOwned } from './owned-child.mjs'
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { platform, arch, release } from 'node:os'
import { build } from 'vite'
import { isPublicBundleExportFailure } from './browser-diagnostics.mjs'
import { chromium } from 'playwright'

const surface = process.argv[process.argv.indexOf('--surface') + 1]
if (!['web', 'desktop'].includes(surface)) {
  console.error('surface must be web or desktop')
  process.exit(2)
}
const root = resolve(import.meta.dirname, '..')
const output = process.env.WEB_CONTROL_NATIVE_DIR ?? join(root, 'data', 'compat')
await mkdir(output, { recursive: true })
const runDir = await mkdtemp(join(output, surface + '-'))
console.log(JSON.stringify({ phase: 'isolated-compat', surface, directory: runDir, runnerPid: process.pid }))
const home = join(runDir, 'home')
await mkdir(home)
const env = { PATH: process.env.PATH, HOME: home, TMPDIR: process.env.TMPDIR,
  DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', NO_COLOR: '1',
  NPM_CONFIG_CACHE: join(runDir, 'npm-cache'), npm_config_store_dir: join(runDir, 'pnpm-store'),
  XDG_CACHE_HOME: join(runDir, 'cache') }
const evidence = { startedAt: new Date().toISOString(), runnerPid: process.pid, surface, version: '0.2.0-rc.2', supported: false,
  os: `${platform()} ${release()} ${arch()}`, node: process.version, checks: [] }
const redact = text => String(text).replace(/([?&]token=)[^\s]+/g, '$1[redacted]')
  .replaceAll(runDir, '[isolated-run]').replaceAll(root, '[project]')
const run = async (command, args, options = {}) => {
  const child = spawn(command, args, { cwd: root, env, ...options, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.on('data', data => { stdout += data })
  child.stderr.on('data', data => { stderr += data })
  const code = await new Promise((done, reject) => { child.on('error', reject); child.on('close', done) })
  evidence.checks.push({ name: command.split('/').at(-1) + ' ' + args.join(' '), ok: code === 0 })
  await writeFile(join(runDir, 'command-' + evidence.checks.length + '.log'), redact(stdout + stderr))
  if (code !== 0) throw new Error('distribution command failed; inspect sanitized command log')
  return stdout
}
let host
let hostLogs = ''
try {
  // Task 7 uses Node26 only for stock Host native dependencies; project tooling stays Node24.
  const task7 = process.argv.includes('--task7-images') || process.argv.includes('--task8-streams') || process.argv.includes('--task9-files')
  const projectNode = process.execPath
  const projectPnpm = process.env.WEB_CONTROL_PNPM_CLI
  if (!projectPnpm || !existsSync(projectPnpm)) throw new Error('compatibility requires explicit WEB_CONTROL_PNPM_CLI')
  {
    await run(projectNode, [projectPnpm, 'run', 'build'], { env: { ...env, PATH: join(root, 'data/node24/node_modules/node-bin-darwin-arm64/bin') + ':' + env.PATH } })
    await run(projectNode, [projectPnpm, '--filter', 'dsh-web-control', 'pack', '--pack-destination', join(root, 'dist')], { env: { ...env, PATH: join(root, 'data/node24/node_modules/node-bin-darwin-arm64/bin') + ':' + env.PATH } })
  }
  await run(projectNode, ['scripts/check-package.mjs'])
  const packed = join(root, 'dist', 'dsh-web-control-0.0.0-compat.1.tgz')
  evidence.pluginSha256 = createHash('sha256').update(await readFile(packed)).digest('hex')
  const tgz = join(runDir, 'plugin-' + evidence.pluginSha256 + '.tgz')
  await copyFile(packed, tgz)
  if (surface === 'desktop') {
    const app = '/Applications/DeepSeek Harness.app'
    if (!existsSync(app)) throw new Error('stock desktop App unavailable')
    evidence.desktopVersion = spawnSync('defaults', ['read', join(app, 'Contents/Info'), 'CFBundleShortVersionString'], { encoding: 'utf8' }).stdout.trim()
    evidence.appSha256 = createHash('sha256').update(await readFile(join(app, 'Contents/Resources/app.asar'))).digest('hex')
    evidence.status = 'NOT_RUN'
    evidence.checks.push({ name: 'stock-desktop.live-smoke', ok: false,
      reason: 'user requires running Desktop tasks remain undisturbed; live validation deferred' })
    throw new Error('Desktop NOT_RUN: no App launch or automation permitted while user tasks are running')
  }
  const runtime = join(root, 'data/compat/runtime-0.2.0-rc.2')
  if (!existsSync(join(runtime, 'node_modules/@deepseek-ai/dsh/package.json'))) {
    await run('npm', ['install', '--prefix', runtime, '--registry=https://registry.npmjs.org',
      '--no-audit', '--no-fund', '@deepseek-ai/dsh@0.2.0-rc.2'])
  }
  const releaseLock = JSON.parse(await readFile(join(runtime, 'package-lock.json'), 'utf8'))
  const launcher = releaseLock.packages['node_modules/@deepseek-ai/dsh']
  if (launcher.version !== evidence.version || !launcher.resolved.startsWith('https://registry.npmjs.org/') || launcher.integrity !== 'sha512-EAJ3gPNcVt/uv8X19PMm9NkVhWgT7xXNMk0UKCVm+IQ5rpSQOcsMUa0HWlnYYVybKMsccjcRB21vVVsaXQ6IdA==') {
    throw new Error('runtime must come from the exact public npm release')
  }
  evidence.releaseIntegrity = launcher.integrity
  const cli = join(runtime, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
  await run(process.execPath, [cli, '--help'])
  await run(process.execPath, [cli, 'plugin', '--profile', 'web', '--help'])
  await run(process.execPath, [cli, 'web', '--help'])
  await run(process.execPath, [cli, 'plugin', '--profile', 'web', 'add', tgz])
  const profile = join(home, 'profiles/web')
  await writeFile(join(profile, '.web-control-compat.json'), JSON.stringify({ isolated: true, captureCoreResolution: true, task7Images: process.argv.includes('--task7-images'), task8Streams: process.argv.includes('--task8-streams'), task9Files: process.argv.includes('--task9-files') }) + '\n')
  const fixture = join(runtime, 'client-smoke.js')
  await writeFile(fixture, `import { SessionEventStream, createSessionControlStream } from '@deepseek-ai/dsh-api-session-controller/client';\nimport { RemoteStream } from '@deepseek-ai/dsh-api-gateway/client';\nexport { SessionEventStream, createSessionControlStream, RemoteStream };\n`)
  try {
    await build({ root: runtime, logLevel: 'silent', build: { lib: { entry: fixture, formats: ['es'] }, outDir: join(runDir, 'client-build') } })
    evidence.checks.push({ name: 'public-client.vite-build', ok: true })
  } catch (error) {
    await writeFile(join(runDir, 'client-build.log'), redact(error.message))
    if (!isPublicBundleExportFailure(error)) {
      throw new Error('unexpected public browser fixture failure; inspect sanitized client-build log')
    }
    evidence.checks.push({ name: 'public-client.vite-build', ok: false, required: false,
      reason: 'DSH registration bundles lack named JS exports; use public protocol adapter' })
  }
  host = spawn(process.execPath, [cli, 'web', '--no-open', '--host', '127.0.0.1', '--port', '0'], { env, cwd: runDir, stdio: ['ignore', 'pipe', 'pipe'] })
  const address = await new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error('stock web startup timed out')), 90_000)
    const consume = chunk => {
      hostLogs += chunk
      const match = hostLogs.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/)
      if (match) { clearTimeout(timer); done(match[1]) }
    }
    host.stdout.on('data', consume); host.stderr.on('data', consume)
    host.once('exit', code => { clearTimeout(timer); reject(new Error('stock web exited: ' + code)) })
  })
  await writeFile(join(runDir, 'host.log'), redact(hostLogs))
  const login = await fetch(address, { redirect: 'manual' })
  const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  const origin = new URL(address).origin
  const rpc = async (method, args) => {
    const reply = await fetch(origin + '/api/' + method, { method: 'POST',
      headers: { 'content-type': 'application/json', cookie, origin },
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args } }),
      signal: AbortSignal.timeout(30_000) })
    const frame = await reply.json()
    if (!reply.ok || !frame.result?.ok) throw new Error('synthetic local session operation rejected')
    return frame.result.value
  }
  const stable = await rpc('session/create', { request: { cwd: runDir } })
  evidence.sessionIdentity = stable.sessionId
  const response = await fetch(origin + '/api/web-control/probe', { method: 'POST',
    headers: { 'content-type': 'application/json', cookie, origin },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: 'web-control/probe', payload: {} }),
    signal: AbortSignal.timeout(30_000) })
  const text = await response.text()
  if (!response.ok) throw new Error('authenticated probe returned HTTP ' + response.status)
  const result = JSON.parse(text)
  evidence.probe = result.result?.value
  evidence.checks.push({ name: 'stock-host.probe', ok: evidence.probe?.supported === true })
  const coreResolution = JSON.parse(await readFile(join(profile, '.web-control-core-resolution.json'), 'utf8'))
  let oneRuntime = true
  for (const [entry, resolved] of Object.entries(coreResolution)) {
    const packageName = entry.split('/').slice(0, 2).join('/')
    const expectedRoot = await realpath(join(runtime, 'node_modules', packageName))
    if (!String(resolved).startsWith(expectedRoot + '/')) oneRuntime = false
  }
  evidence.coreResolution = Object.fromEntries(Object.entries(coreResolution).map(([entry, value]) => [entry, redact(value)]))
  evidence.checks.push({ name: 'stock-host.single-core-runtime', ok: oneRuntime && Object.keys(coreResolution).length === (process.argv.includes('--task7-images') ? 15 : process.argv.includes('--task8-streams') ? 14 : 11) })
  if (process.argv.includes('--task8-streams')) {
    await writeFile(join(runDir, 'public-follow-fixture.json'), redact(await readFile(join(profile, '.web-control-follow-fixture.json'), 'utf8')))
    await writeFile(join(runDir, 'public-opening-fixture.json'), redact(await readFile(join(profile, '.web-control-opening-fixture.json'), 'utf8')))
  }
  if (process.argv.includes('--task9-files')) evidence.filesFixture = JSON.parse(await readFile(join(profile, '.web-control-files-fixture.json'), 'utf8'))
  evidence.processId = host.pid
  evidence.referencePackageResolution = redact(await realpath(join(profile, 'node_modules/dsh-web-control')))
  await writeFile(join(runDir, 'web-ui-instructions.json'), JSON.stringify({ origin, pid: host.pid,
    required: ['open authenticated test UI', 'General compatibility entry visible', 'uninstall', 'local same-session check'] }, null, 2))
  // Keep the existing UI fixture standard; opt-in Task7 evidence belongs to the first authenticated probe.
  if (process.argv.includes('--task7-images') || process.argv.includes('--task8-streams') || process.argv.includes('--task9-files')) await writeFile(join(profile, '.web-control-compat.json'), '{"isolated":true,"captureCoreResolution":true}\n')
  const browser = await chromium.launch({ ...(process.env.WEB_CONTROL_CHROMIUM_EXECUTABLE ? { executablePath: process.env.WEB_CONTROL_CHROMIUM_EXECUTABLE } : {}), headless: true, env })
  try {
    const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 900 } })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(address)
    await page.waitForLoadState('networkidle')
    const notice = page.getByRole('button', { name: /^Continue$/ })
    await notice.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {})
    if (await notice.isVisible()) { await notice.click(); await notice.waitFor({ state: 'hidden' }) }
    const later = page.getByRole('button', { name: /^Configure later$/ })
    await later.waitFor({ state: 'visible', timeout: 15_000 })
    await later.click()
    await later.waitFor({ state: 'hidden' })
    await writeFile(join(runDir, 'ui-dom.txt'), redact(await page.locator('body').innerText()))
    await page.screenshot({ path: join(runDir, 'ui-initial.png') })
    // Locate the stock Settings control by its accessibility label.
    await page.getByRole('button', { name: /^Settings$/ }).click({ timeout: 15_000 })
    await page.getByRole('button', { name: /^Manage Web Control$/ }).waitFor({ state: 'visible', timeout: 15_000 })
    await page.getByRole('button', { name: /^Manage Web Control$/ }).click()
    await page.getByRole('dialog', { name: 'Web Control', exact: true }).waitFor({ state: 'visible' })
    await page.getByRole('dialog', { name: 'Web Control', exact: true }).getByRole('button', { name: 'Close', exact: true }).click()
    await page.screenshot({ path: join(runDir, 'ui-compat.png') })
    evidence.checks.push({ name: 'stock-ui.mount', ok: true })
    evidence.checks.push({ name: 'stock-ui.console', ok: errors.length === 0 })
    await writeFile(join(profile, '.web-control-compat.json'), '{"isolated":true,"captureCoreResolution":true,"pauseAtApproval":true}\n')
    const pending = fetch(origin + '/api/web-control/probe', { method: 'POST',
      headers: { 'content-type': 'application/json', cookie, origin },
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: 'web-control/probe', payload: {} }),
      signal: AbortSignal.timeout(30_000) }).then(reply => reply.json())
    // Poll only the task-owned fixture diagnostic, never a production profile.
    const pendingDeadline = Date.now() + 10_000
    let state
    do {
      try { state = JSON.parse(await readFile(join(profile, '.web-control-probe-state.json'), 'utf8')) } catch {}
      if (state?.state === 'approval-pending') break
      await new Promise(done => setTimeout(done, 50))
    } while (Date.now() < pendingDeadline)
    if (state?.state !== 'approval-pending') throw new Error('synthetic pending-approval fixture did not start')
    await run(process.execPath, [cli, 'plugin', '--profile', 'web', 'remove', 'dsh-web-control'])
    const cancelledReport = (await pending).result.value
    const cleaned = JSON.parse(await readFile(join(profile, '.web-control-probe-state.json'), 'utf8'))
    evidence.checks.push({ name: 'stock-host.unload-pending-probe', ok: cancelledReport.supported === false
      && cancelledReport.checks.some(check => check.name === 'fixture.cleanup' && check.ok)
      && cleaned.state === 'cleaned' && cleaned.clean === true })
    await page.getByRole('button', { name: /^Manage Web Control$/ }).waitFor({ state: 'detached', timeout: 15_000 })
    const renamed = await rpc('session/rename', { request: { sessionId: stable.sessionId, title: 'Synthetic session after uninstall' } })
    const local = await rpc('session/list', { _request: {} })
    evidence.checks.push({ name: 'stock-ui.unload-same-session',
      ok: renamed.title === 'Synthetic session after uninstall' && local.items.some(item => item.sessionId === stable.sessionId) && host.exitCode === null })
    await page.screenshot({ path: join(runDir, 'ui-unloaded.png') })
  } finally { await browser.close() }
  evidence.supported = evidence.checks.every(check => check.ok || check.required === false)
} catch (error) {
  evidence.blocker = redact(error.message)
} finally {
  // Only the task-owned CLI child is signalled; Desktop is never launched.
  if (host) {
    try { await stopOwned(host) } catch (error) { evidence.supported = false; evidence.cleanupFailure = error.message }
    evidence.processId = host.pid
    evidence.hostExit = { code: host.exitCode, signal: host.signalCode }
    const exited = host.exitCode !== null || host.signalCode !== null
    evidence.checks.push({ name: 'owned-host.exited', ok: exited })
    if (!exited) evidence.supported = false
    await writeFile(join(runDir, 'host.log'), redact(hostLogs))
  }
  evidence.checks = evidence.checks.map(check => ({ ...check, name: redact(check.name) }))
  evidence.finishedAt = new Date().toISOString()
  await writeFile(join(runDir, 'evidence.json'), JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify({ surface, supported: evidence.supported, version: evidence.version,
    status: evidence.status, checks: evidence.checks, probe: evidence.probe, blocker: redact(evidence.blocker ?? '') }))
  process.exitCode = evidence.supported ? 0 : 1
}
