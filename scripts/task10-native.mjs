import { stopOwned } from './owned-child.mjs'
import { spawn, execFileSync } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile, copyFile, realpath, rm } from 'node:fs/promises'
import { platform, arch, release } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer as tlsServer } from 'node:tls'
import { connect } from 'node:net'
import { request as httpsRequest } from 'node:https'
import { chromium, expect } from '@playwright/test'
import { createRequire } from 'node:module'
const QRCode = createRequire(new URL('../packages/plugin/package.json', import.meta.url))('qrcode')
const root = resolve(import.meta.dirname, '..')
const hash = value => createHash('sha256').update(value).digest('hex')
if (process.argv.includes('--remove-device')) {
  const { AuthStore } = await import('../packages/relay/dist/auth.js')
  const [dir, instanceId] = process.argv.slice(-2)
  const auth = new AuthStore(join(dir, 'relay.sqlite'), { now: Date.now }, hash(await readFile(join(dir, 'enrollment'), 'utf8')))
  try { auth.remove(instanceId) } finally { auth.close() }
} else if (process.argv.includes('--relay')) {
  const dir = process.argv.at(-1)
  const { startRelay } = await import('../packages/relay/dist/server.js')
  const key = await readFile(join(dir, 'key.pem')), cert = await readFile(join(dir, 'cert.pem'))
  let relay
  const sockets = new Set()
  const tls = tlsServer({ key, cert }, incoming => {
    if (!relay) return incoming.destroy()
    const upstream = connect(relay.port, '127.0.0.1'); sockets.add(incoming); sockets.add(upstream)
    incoming.on('error', () => upstream.destroy()); upstream.on('error', () => incoming.destroy())
    incoming.on('close', () => { sockets.delete(incoming); upstream.destroy() }); upstream.on('close', () => { sockets.delete(upstream); incoming.destroy() })
    incoming.pipe(upstream).pipe(incoming)
  })
  const requestedPort = process.env.WEB_CONTROL_RELAY_PORT ? Number(process.env.WEB_CONTROL_RELAY_PORT) : 0
  await new Promise(done => tls.listen(requestedPort, '127.0.0.1', done))
  const origin = `https://localhost:${tls.address().port}`
  const DEFAULT_LIMITS = { jsonBytes: 262144, chunkBytes: 65536, fileBytes: 33554432, calls: 16, streams: 16, uploads: 2, bufferedBytes: 4194304, callTimeoutMs: 30000, transferIdleMs: 60000 }
  relay = await startRelay({ publicOrigin: origin, listenHost: '127.0.0.1', port: 0, databasePath: join(dir, 'relay.sqlite'), staticDir: join(root, 'packages/web/dist'), enrollmentVerifier: hash(await readFile(join(dir, 'enrollment'), 'utf8')), heartbeatMs: 1000, leaseTtlMs: 5000, limits: DEFAULT_LIMITS })
  await writeFile(join(dir, 'relay-ready.json'), JSON.stringify({ origin, node: process.version, pid: process.pid }))
  process.once('SIGTERM', async () => { for (const socket of sockets) socket.destroy(); await relay.close(); tls.close(); process.exit(0) })
} else {
  const node24 = process.execPath
  const pnpm = (process.env.WEB_CONTROL_PNPM_CLI ?? process.env.npm_execpath ?? join(root,'node_modules/pnpm/bin/pnpm.mjs'))
  const dir = await mkdtemp(join(process.env.WEB_CONTROL_NATIVE_DIR ?? join(root, 'data/compat'), 'task10-web-'))
  const home = join(dir, 'home'); await mkdir(home)
  const runtime = join(root, 'data/compat/runtime-0.2.0-rc.2'), cli = join(runtime, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
  const env = { PATH: process.env.PATH, HOME: home, TMPDIR: process.env.TMPDIR, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', NO_COLOR: '1', NPM_CONFIG_CACHE: join(dir, 'npm-cache'), XDG_CACHE_HOME: join(dir, 'cache'), NODE_EXTRA_CA_CERTS: join(dir, 'cert.pem') }
  console.log(JSON.stringify({ status: 'RUNNING', phase: 'isolated-stock-web', runnerPid: process.pid, directory: dir }))
  const ownedProcesses = []
  const recordOwned = async (child, role) => { ownedProcesses.push({ role, pid: child.pid, executable: child.spawnfile, argv: child.spawnargs, startedAt: new Date().toISOString() }); await writeFile(join(dir, 'owned-processes.json'), JSON.stringify({ runnerPid: process.pid, processes: ownedProcesses }, null, 2)) }
  const sourceFiles = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' }).trim().split('\n').filter(path => /^(?:Dockerfile|\.dockerignore|package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|tsconfig\.json)$/.test(path) || /^packages\/(plugin|relay|web|protocol)\/(src\/.*\.(ts|tsx|css|sql)|package\.json|tsdown\.config\.ts|vite\.config\.ts|build\.mjs|index\.html|cordis\.patch\.yml)$/.test(path)).sort()
  const buildInputs = { algorithm: 'sha256', digest: hash((await Promise.all(sourceFiles.map(async path => path + '\0' + hash(await readFile(join(root, path)))))).join('\n')), files: sourceFiles.length }
  const evidence = { runnerPid: process.pid, source: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), dirty: !!execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(), buildInputs, environment: `${platform()} ${release()} ${arch()}`, startedAt: new Date().toISOString(), status: 'RUNNING', projectNode: execFileSync(node24, ['--version'], { encoding: 'utf8' }).trim(), stockNode: process.version, desktop: 'NOT_RUN', checks: [], processes: [] }
  const logs = []; const secrets = []; const relaySecrets = []; let host, relayChild, browser, address, cookie, origin
  const assert = (name, ok) => { evidence.checks.push({ name, ok }); if (!ok) throw new Error(name) }
  const run = async (command, args, extra = {}) => {
    const child = spawn(command, args, { cwd: root, env, ...extra, stdio: ['ignore', 'pipe', 'pipe'] }); let output = ''
    child.stdout.on('data', chunk => { output += chunk }); child.stderr.on('data', chunk => { output += chunk })
    const code = await new Promise((done, reject) => { child.on('error', reject); child.on('close', done) }); logs.push(output)
    if (code !== 0) throw new Error('owned command failed: ' + args[0]); return output
  }
  const stop = async child => {
    if (!child) return
    await stopOwned(child)
    evidence.processes.push({ pid: child.pid, exitCode: child.exitCode, signal: child.signalCode })
  }
  const start = async () => {
    host = spawn(process.execPath, [cli, 'web', '--no-open', '--host', '127.0.0.1', '--port', '0'], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] })
    await recordOwned(host, 'stock-web')
    address = await new Promise((done, reject) => {
      let output = ''; const timer = setTimeout(() => reject(new Error('owned Web startup timeout')), 90000)
      const consume = chunk => { output += chunk; const match = output.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/); if (match) { clearTimeout(timer); done(match[1]) } }
      host.stdout.on('data', consume); host.stderr.on('data', consume); host.once('exit', () => { clearTimeout(timer); logs.push(output); reject(new Error('owned Web exited before startup')) })
    })
    secrets.push(new URL(address).searchParams.get('token'))
    const login = await fetch(address, { redirect: 'manual' }); cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; '); origin = new URL(address).origin
  }
  const rpc = async (method, args, raw = false) => {
    const response = await fetch(origin + '/api/' + method, { method: 'POST', headers: { 'content-type': 'application/json', origin, cookie }, body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args } }), signal: AbortSignal.timeout(method === 'web-control/probe' ? 240000 : 30000) })
    const reply = await response.json(); if (!raw && (!response.ok || !reply.result?.ok)) throw new Error('local RPC failed: ' + method + ':' + reply.result?.error?.code); return raw ? reply : reply.result.value
  }
  const manage = input => rpc('web-control/manage', input)
  const relayPost = (relayOrigin, path, body) => new Promise((done, reject) => {
    const request = httpsRequest(new URL(path, relayOrigin), { method: 'POST', ca: cert, headers: { 'content-type': 'application/json', origin: relayOrigin } }, response => { let text = ''; response.on('data', chunk => { text += chunk }); response.once('end', () => done({ status: response.statusCode, code: JSON.parse(text).error?.code })) }); request.on('error', reject); request.end(JSON.stringify(body))
  })
  let cert
  try {
    await run(node24, [pnpm, 'run', 'build'], { env: { ...env, NODE_EXTRA_CA_CERTS: undefined, PATH: join(root, 'data/node24/node_modules/node-bin-darwin-arm64/bin') + ':' + env.PATH } })
    await run(node24, [pnpm, '--filter', 'dsh-web-control', 'pack', '--pack-destination', join(root, 'dist')], { env: { ...env, NODE_EXTRA_CA_CERTS: undefined } })
    if (process.argv.includes('--final-ui')) await run(node24, [pnpm, '--filter', '@dsh-web-control/relay', 'pack', '--pack-destination', join(root, 'dist')], { env: { ...env, NODE_EXTRA_CA_CERTS: undefined } })
    await run(node24, ['scripts/check-package.mjs'], { env: { ...env, NODE_EXTRA_CA_CERTS: undefined } })
    const archive = join(root, 'dist/dsh-web-control-0.0.0-compat.1.tgz'); evidence.pluginSha256 = hash(await readFile(archive)); const packed = join(dir, 'plugin.tgz'); await copyFile(archive, packed)
    const lock = JSON.parse(await readFile(join(runtime, 'package-lock.json'), 'utf8')).packages['node_modules/@deepseek-ai/dsh']
    assert('pinned-public-runtime', lock.version === '0.2.0-rc.2' && lock.resolved.startsWith('https://registry.npmjs.org/') && lock.integrity === 'sha512-EAJ3gPNcVt/uv8X19PMm9NkVhWgT7xXNMk0UKCVm+IQ5rpSQOcsMUa0HWlnYYVybKMsccjcRB21vVVsaXQ6IdA=='); evidence.releaseIntegrity = lock.integrity
    await writeFile(join(dir, 'cert.cnf'), '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyCertSign,keyEncipherment\n')
    await run('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-days', '1', '-config', join(dir, 'cert.cnf')], { env: { ...env, NODE_EXTRA_CA_CERTS: undefined } })
    cert = await readFile(join(dir, 'cert.pem')); const enrollment = randomBytes(32).toString('base64url'); secrets.push(enrollment); relaySecrets.push(enrollment); await writeFile(join(dir, 'enrollment'), enrollment, { mode: 0o600 })
    relayChild = spawn(node24, [import.meta.filename, '--relay', dir], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] }); await recordOwned(relayChild, 'tls-relay'); relayChild.stdout.on('data', data => logs.push(String(data))); relayChild.stderr.on('data', data => logs.push(String(data)))
    let relay; for (let i = 0; i < 100; i++) { try { relay = JSON.parse(await readFile(join(dir, 'relay-ready.json'), 'utf8')); break } catch {} await new Promise(done => setTimeout(done, 50)) }; if (!relay) throw new Error('owned TLS relay did not start')
    evidence.relayNode = relay.node
    await run(process.execPath, [cli, 'plugin', '--profile', 'web', 'add', packed]); const profile = join(home, 'profiles/web')
    await writeFile(join(profile, '.web-control-compat.json'), '{"isolated":true,"captureCoreResolution":true}\n')
    await start(); assert('nonmutating-startup-disabled', (await manage({ action: 'status' })).status.phase === 'disabled')
    browser = await chromium.launch({ ...(process.env.WEB_CONTROL_CHROMIUM_EXECUTABLE ? { executablePath: process.env.WEB_CONTROL_CHROMIUM_EXECUTABLE } : {}), headless: true, env })
    const context = await browser.newContext({ ignoreHTTPSErrors: true, locale: 'en-US', viewport: { width: 1280, height: 900 } }); const page = await context.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message))
    await page.goto(address); await page.waitForLoadState('networkidle')
    const notice = page.getByRole('button', { name: /^Continue$/ }); await notice.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {}); if (await notice.isVisible()) await notice.click()
    const later = page.getByRole('button', { name: /^Configure later$/ }); await later.waitFor({ state: 'visible', timeout: 15000 }); await later.click()
    await page.getByRole('button', { name: /^Settings$/ }).click(); await page.getByRole('button', { name: 'Manage Web Control', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Web Control', exact: true }); await dialog.getByLabel('Relay HTTPS origin').fill(relay.origin); await dialog.getByLabel('First registration credential').fill(enrollment); await dialog.getByRole('button', { name: 'Enable', exact: true }).click()
    await dialog.locator('output').filter({ hasText: /^Ready$/ }).waitFor({ timeout: 20000 })
    const first = await manage({ action: 'link' }); const firstURL = new URL(first.link); secrets.push(firstURL.hash.slice(5)); relaySecrets.push(firstURL.hash.slice(5)); evidence.linkHash = hash(first.link)
    const modules = QRCode.create(first.link).modules
    assert('bundled-local-qr-acknowledged-url-pixels', await dialog.locator('canvas').evaluate((canvas, qr) => {
      const context = canvas.getContext('2d'); if (!context || canvas.width !== 192 || canvas.height !== 192) return false
      const scale = 192 / (qr.size + 4)
      for (let row = 0; row < qr.size; row++) for (let col = 0; col < qr.size; col++) {
        const pixel = context.getImageData(Math.floor((col + 2.5) * scale), Math.floor((row + 2.5) * scale), 1, 1).data
        if ((pixel[0] < 128) !== Boolean(qr.data[row * qr.size + col])) return false
      }
      return true
    }, { size: modules.size, data: [...modules.data] }))
    await dialog.getByRole('button', { name: 'Close', exact: true }).click(); assert('modal-close-stays-ready', (await manage({ action: 'status' })).status.phase === 'ready'); await page.screenshot({ path: join(dir, 'management-row.png') })
    // The existing isolated fixture supplies local synthetic prompt/approval; no paid model/account.
    const report = await rpc('web-control/probe', {}); assert('local-synthetic-prompt-while-enabled', report.supported && report.checks.some(check => check.name === 'session.prompt-acceptance' && check.ok))
    const resolutions = JSON.parse(await readFile(join(profile, '.web-control-core-resolution.json'), 'utf8')); assert('one-public-core-runtime', (await Promise.all(Object.entries(resolutions).map(async ([entry, value]) => value.startsWith(await realpath(join(runtime, 'node_modules', entry.split('/').slice(0, 2).join('/'))))))).every(Boolean))
    assert('ordinary-admission-denies-unauthenticated-management', (await fetch(origin + '/api/web-control/manage', { method: 'POST', body: '{}' })).status !== 200)
    if (process.argv.includes('--final-ui')) {
      await writeFile(join(profile, '.web-control-compat.json'), '{"isolated":true,"captureCoreResolution":true,"task15UI":true}\n')
      const pending = rpc('web-control/probe', {}); void pending.catch(() => {})
      let fixture
      for (let i = 0; i < 150; i++) { try { fixture = JSON.parse(await readFile(join(profile, '.web-control-ui-state.json'), 'utf8')); if (fixture.state === 'ready') break } catch {} await new Promise(done => setTimeout(done, 100)) }
      assert('final-ui-native-fixture-ready', fixture?.state === 'ready')
      const remote = await context.newPage(); remote.on('pageerror', error => errors.push(error.message))
      const began = performance.now(); await remote.goto(first.link)
      await expect(remote.getByRole('status', { name: '连接状态' })).toHaveText('已连接', { timeout: 20000 })
      await remote.locator('.session-list').getByRole('button', { name: 'Task15 native session', exact: true }).click()
      await expect(remote.getByRole('button', { name: '允许一次', exact: true })).toBeEnabled({ timeout: 15000 })
      await remote.getByRole('button', { name: '允许一次', exact: true }).click()
      await expect(remote.locator('.message.live')).toContainText('Task15 native live output', { timeout: 15000 })
      assert('final-ui-same-local-session', new URL(remote.url()).searchParams.get('session') === fixture.sessionId)
      evidence.firstOperationalMs = performance.now() - began
      evidence.browser = { name: 'Chromium', version: browser.version(), executableOverride: !!process.env.WEB_CONTROL_CHROMIUM_EXECUTABLE }
      evidence.viewports = []
      for (const width of [360, 390, 768, 1280]) {
        await remote.setViewportSize({ width, height: 900 })
        await expect.poll(() => remote.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        evidence.viewports.push({ width, height: 900, noOverflow: true })
        await remote.screenshot({ path: join(dir, `final-ui-${width}.png`) })
      }
      await remote.getByRole('button', { name: '停止', exact: true }).click()
      await expect(remote.getByText('停止请求已提交')).toBeVisible()
      await expect(remote.getByRole('button', { name: '停止', exact: true })).toBeDisabled({ timeout: 15000 })
      await remote.getByLabel('添加附件').setInputFiles({ name: 'task15.txt', mimeType: 'text/plain', buffer: Buffer.from('task15 native upload') })
      await expect(remote.getByText('task15.txt · 已上传')).toBeVisible({ timeout: 15000 })
      await remote.getByRole('textbox', { name: '消息', exact: true }).fill('Task15 remote prompt')
      await remote.getByRole('button', { name: '发送', exact: true }).click()
      await expect(remote.getByText('消息已由本机接受')).toBeVisible({ timeout: 15000 })
      await expect(remote.getByRole('button', { name: '允许一次', exact: true })).toBeEnabled({ timeout: 15000 })
      await remote.getByRole('button', { name: '允许一次', exact: true }).click()
      await expect(remote.locator('.message.live')).toContainText('Task15 native live output', { timeout: 15000 })
      await remote.getByRole('button', { name: '停止', exact: true }).click()
      await expect(remote.getByRole('button', { name: '停止', exact: true })).toBeDisabled({ timeout: 15000 })
      await remote.goto(relay.origin)
      await new Promise(done => setTimeout(done, 250))
      const readLogin = await remote.evaluate(async ({ instanceId, secret }) => (await fetch(`/v1/instances/${instanceId}/login`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ secret }) })).status, { instanceId: firstURL.pathname.split('/').at(-1), secret: new URLSearchParams(firstURL.hash.slice(1)).get('key') })
      assert('final-native-file-read-probe-reauthorized', readLogin === 200)
      const readGate = await remote.evaluate(({ instanceId, sessionId }) => new Promise(resolve => {
        const socket = new WebSocket(`${location.origin.replace('https:', 'wss:')}/v1/instances/${instanceId}/control`)
        let result = 'NO_RESULT', binaryFrames = 0
        const timer = setTimeout(() => { result = 'TIMEOUT'; socket.close() }, 10000)
        const resume = JSON.parse(sessionStorage.getItem(`dsh:resume:${instanceId}`) ?? 'null')
        socket.onopen = () => socket.send(JSON.stringify({ v: 1, type: 'browser.hello', versions: [1], ...(resume ? { resume } : {}) }))
        socket.onmessage = event => {
          if (typeof event.data !== 'string') { binaryFrames++; return }
          const frame = JSON.parse(event.data)
          if (frame.type === 'browser.lease') socket.send(JSON.stringify({ v: 1, type: 'browser.lease-ack', id: frame.id }))
          if (frame.type === 'ready') socket.send(JSON.stringify({ v: 1, type: 'call', id: crypto.randomUUID(), fence: frame.fence, command: { op: 'file.read', sessionId, path: 'current.txt', offset: 0, length: 1 } }))
          if (frame.type === 'result') { result = frame.result.ok ? 'UNEXPECTED_SUCCESS' : frame.result.error.code; socket.close() }
          if (frame.type === 'fault') { result = frame.error.code; socket.close() }
        }
        socket.onclose = () => { clearTimeout(timer); resolve({ result, binaryFrames }) }
      }), { instanceId: firstURL.pathname.split('/').at(-1), sessionId: fixture.sessionId })
      evidence.currentReadGate = readGate
      assert('final-native-current-file-read-fails-closed', readGate.result === 'PROTOCOL_UNSUPPORTED' && readGate.binaryFrames === 0)
      await remote.close()
      await writeFile(join(profile, '.web-control-ui-done.json'), '{"done":true}\n')
      assert('final-ui-real-relay-native-controls', (await pending).supported)
      evidence.nativeUI = JSON.parse(await readFile(join(profile, '.web-control-ui-state.json'), 'utf8'))
      evidence.nativeUICleanup = JSON.parse(await readFile(join(profile, '.web-control-ui-cleanup.json'), 'utf8'))
      assert('final-ui-native-cleanup', evidence.nativeUICleanup.clean && evidence.nativeUICleanup.pendingModelStreams === 0)
      const finalResolution = JSON.parse(await readFile(join(profile, '.web-control-core-resolution.json'), 'utf8'))
      assert('final-ui-one-public-core-runtime', Object.keys(finalResolution).length === 12 && (await Promise.all(Object.entries(finalResolution).map(async ([entry, value]) => value.startsWith(await realpath(join(runtime, 'node_modules', entry.split('/').slice(0, 2).join('/'))))))).every(Boolean))
      await writeFile(join(profile, '.web-control-compat.json'), '{"isolated":true,"captureCoreResolution":true}\n')
    }
    assert('ui-console-clean', errors.length === 0); await browser.close(); browser = undefined
    await stop(host); host = undefined; await start()
    let restarted; for (let i = 0; i < 100; i++) { restarted = await manage({ action: 'link' }); if (restarted.link) break; await new Promise(done => setTimeout(done, 100)) }
    assert('actual-provider-Web-restart-link-persistence', restarted.link === first.link)
    await run(process.execPath, [cli, 'plugin', '--profile', 'web', 'remove', 'dsh-web-control']); await run(process.execPath, [cli, 'plugin', '--profile', 'web', 'add', packed])
    await new Promise(done => setTimeout(done, 1000)); let reinstalled; for (let i = 0; i < 100; i++) { reinstalled = await manage({ action: 'link' }); if (reinstalled.link) break; await new Promise(done => setTimeout(done, 100)) }
    assert('remove-reinstall-retains-authorized-identity', reinstalled.link === first.link)
    const rotated = await manage({ action: 'rotate' }); assert('rotation-ACK-new-link', !!rotated.link && rotated.link !== first.link)
    assert('old-link-rejected-after-rotate', (await relayPost(relay.origin, firstURL.pathname.replace('/connect/', '/v1/instances/') + '/login', { secret: new URLSearchParams(firstURL.hash.slice(1)).get('key') })).code === 'AUTH_FAILED')
    const rotatedURL = new URL(rotated.link); secrets.push(new URLSearchParams(rotatedURL.hash.slice(1)).get('key')); relaySecrets.push(new URLSearchParams(rotatedURL.hash.slice(1)).get('key'))
    await manage({ action: 'stop' }); assert('stop-durable-disabled', (await manage({ action: 'status' })).status.phase === 'disabled')
    assert('stopped-link-rejected', (await relayPost(relay.origin, `/v1/instances/${rotated.status.instanceId}/login`, { secret: new URLSearchParams(rotatedURL.hash.slice(1)).get('key') })).code === 'AUTH_REVOKED')
    await stop(host); host = undefined; await start(); assert('stopped-restart-remains-disabled', (await manage({ action: 'status' })).status.phase === 'disabled')
    if (process.argv.includes('--final-fix')) {
      const restartRelay = async port => {
        await stop(relayChild); relayChild = undefined
        await rm(join(dir, 'relay-ready.json'), { force: true })
        relayChild = spawn(node24, [import.meta.filename, '--relay', dir], { cwd: root, env: { ...env, WEB_CONTROL_RELAY_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] })
        await recordOwned(relayChild, 'tls-relay-replacement'); relayChild.stdout.on('data', data => logs.push(String(data))); relayChild.stderr.on('data', data => logs.push(String(data)))
        for (let i = 0; i < 100; i++) { try { return JSON.parse(await readFile(join(dir, 'relay-ready.json'), 'utf8')) } catch {} await new Promise(done => setTimeout(done, 50)) }
        throw new Error('replacement relay unavailable')
      }
      await stop(relayChild); relayChild = undefined
      await run(node24, [import.meta.filename, '--remove-device', dir, rotated.status.instanceId])
      relay = await restartRelay(Number(new URL(relay.origin).port))
      const refused = await rpc('web-control/manage', { action: 'configure', relayOrigin: relay.origin, enrollmentSecret: enrollment }, true)
      const afterConfigure = await manage({ action: 'status' })
      evidence.registrationRecovery = { configureError: refused.result.error?.code, oldInstanceId: rotated.status.instanceId, afterConfigureInstanceId: afterConfigure.status.instanceId }
      assert('removed-device-does-not-auto-reset', !refused.result.ok && refused.result.error.code === 'REGISTRATION_FAILED' && afterConfigure.status.instanceId === rotated.status.instanceId)
      const badSecret = randomBytes(32).toString('base64url'); secrets.push(badSecret)
      const failed = await rpc('web-control/manage', { action: 'replace-registration', relayOrigin: relay.origin, enrollmentSecret: badSecret }, true)
      const saved = await manage({ action: 'status' })
      Object.assign(evidence.registrationRecovery, { failedEnrollmentCode: failed.result.error?.code, freshSavedInstanceId: saved.status.instanceId })
      assert('replacement-failure-keeps-fresh-identity', !failed.result.ok && saved.status.instanceId !== rotated.status.instanceId)
      const replaced = await manage({ action: 'configure', relayOrigin: relay.origin, enrollmentSecret: enrollment })
      assert('same-relay-tombstone-explicit-recovery', !!replaced.link && replaced.status.instanceId === saved.status.instanceId)
      secrets.push(new URLSearchParams(new URL(replaced.link).hash.slice(1)).get('key'))
      const tombstone = await relayPost(relay.origin, `/v1/instances/${rotated.status.instanceId}/login`, { secret: new URLSearchParams(rotatedURL.hash.slice(1)).get('key') })
      evidence.registrationRecovery.independentOwnedRelayTombstoneCode = tombstone.code
      assert('old-tombstone-remains-revoked', tombstone.code === 'AUTH_REVOKED')
      relay = await restartRelay(0)
      const moved = await manage({ action: 'replace-registration', relayOrigin: relay.origin, enrollmentSecret: enrollment })
      assert('explicit-relay-origin-change', !!moved.link && moved.status.instanceId !== replaced.status.instanceId && new URL(moved.link).origin === relay.origin)
      secrets.push(new URLSearchParams(new URL(moved.link).hash.slice(1)).get('key'))
      await stop(host); host = undefined; await start()
      let restored; for (let i = 0; i < 100; i++) { restored = await manage({ action: 'link' }); if (restored.link) break; await new Promise(done => setTimeout(done, 100)) }
      assert('fresh-registration-survives-stock-restart', restored.link === moved.link)
      await manage({ action: 'stop' })
    }
    assert('enrollment-not-persisted-in-owned-home' , !(await run('rg', ['-uuu', '-lF', '--', enrollment, home]).catch(() => '')).trim())
    const credentialText = await readFile(join(home, '.credentials.yaml'), 'utf8')
    const device = credentialText.match(/deviceSecret:\s*['"]?([A-Za-z0-9_-]{43})/)?.[1]
    assert('actual-public-provider-device-record', !!device); secrets.push(device); relaySecrets.push(device)
    // DSH's standard startup prints its local bootstrap token; redact that known host output before storage.
    assert('plugin-logs-no-relay-secrets', logs.every(log => relaySecrets.every(secret => !log.includes(secret))))
    evidence.status = 'PASS'
  } catch (error) { evidence.status = 'FAIL'; evidence.failure = String(error.message) }
  finally {
    await browser?.close(); try { await stop(host); await stop(relayChild) } catch (error) { evidence.cleanupFailure = error.message; evidence.status = 'FAIL' }
    await rm(join(dir, 'key.pem'), { force: true }); await rm(join(dir, 'enrollment'), { force: true })
    evidence.ephemeralTLSAndEnrollmentRemoved = true
    const redact = value => secrets.reduce((text, secret) => secret ? text.replaceAll(secret, '[redacted]') : text, String(value)).replace(/([?&]token=)[^\s]+/g, '$1[redacted]').replaceAll(dir, '[owned-run]').replaceAll(root, '[project]')
    evidence.finishedAt = new Date().toISOString()
    await writeFile(join(dir, 'run.log'), redact(logs.join('\n'))); await writeFile(join(dir, 'evidence.json'), redact(JSON.stringify(evidence, null, 2)) + '\n')
    console.log(JSON.stringify({ status: evidence.status, evidence: join(dir, 'evidence.json'), failure: evidence.failure ? redact(evidence.failure) : undefined })); if (evidence.status !== 'PASS') process.exitCode = 1
  }
}
