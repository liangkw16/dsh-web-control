import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, cpSync, rmSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { request } from 'node:https'
import { createRequire } from 'node:module'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WebSocket = createRequire(resolve(root, 'packages/relay/package.json'))('ws')
mkdirSync(resolve(root, 'data'), { recursive: true, mode: 0o700 })
const directory = mkdtempSync(resolve(process.env.WEB_CONTROL_NATIVE_DIR ?? resolve(root, 'data'), 'deploy-smoke-')), project = 'dsh-task14-' + randomUUID().slice(0, 8)
const lock = JSON.parse(readFileSync(resolve(root, 'deploy/images.lock.json')))
const env = Object.fromEntries(readFileSync(resolve(root, 'deploy/.env'), 'utf8').trim().split('\n').map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)] }))
const run = (...args) => execFileSync('docker', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).trim()
const composeArgs = ['compose', '--project-name', project, '--env-file', resolve(directory, '.env'), '-f', resolve(directory, 'compose.yaml'), '-f', resolve(directory, 'smoke.yaml')]
const compose = (...args) => run(...composeArgs, ...args)
const ownedPeers = []
let started = false, completed = false, passedStartup = false
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
try {
  assert.equal(lock.mode, 'local-candidate', 'Smoke requires explicit local candidate configuration')
  assert.equal(lock.relay.reference, env.RELAY_IMAGE)
  for (const name of ['compose.yaml', 'Caddyfile', 'nginx.conf.example', 'images.lock.json']) cpSync(resolve(root, 'deploy', name), resolve(directory, name))
  mkdirSync(resolve(directory, 'secrets'), { mode: 0o700 })
  // Exercise the shipped init path in the actual image, never substitute a permissive secret.
  run('run', '--rm', '--network', 'none', '--read-only', '--user', `${env.RELAY_UID}:${env.RELAY_GID}`, '--mount', `type=bind,src=${directory}/secrets,dst=/secrets`, env.RELAY_IMAGE, 'init', '--secret-file', '/secrets/enrollment')
  writeFileSync(resolve(directory, '.env'), Object.entries({ ...env, CONTROL_DOMAIN: 'task14.localhost' }).map(([key, value]) => `${key}=${value}`).join('\n') + '\n', { mode: 0o600 })
  execFileSync(process.execPath, [resolve(root, 'scripts/configure-deploy.mjs'), '--check', '--local-candidate', '--directory', directory], { stdio: 'inherit' })
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', resolve(directory, 'key.pem'), '-out', resolve(directory, 'cert.pem'), '-days', '1', '-subj', '/CN=task14.localhost', '-addext', 'subjectAltName=DNS:task14.localhost'], { stdio: 'ignore' })
  const caddy = readFileSync(resolve(directory, 'Caddyfile'), 'utf8').replace('    reverse_proxy', '    tls /tls/cert.pem /tls/key.pem\n    reverse_proxy')
  writeFileSync(resolve(directory, 'Caddyfile'), '{\n auto_https disable_redirects\n}\n' + caddy)
  writeFileSync(resolve(directory, 'nginx.conf'), readFileSync(resolve(directory, 'nginx.conf.example'), 'utf8').replace('control.example.com', 'task14.localhost').replaceAll('/etc/nginx/tls/', '/tls/'))
  writeFileSync(resolve(directory, 'smoke.yaml'), `services:
  caddy:
    ports: !override
      - "127.0.0.1::443"
    volumes:
      - "./cert.pem:/tls/cert.pem:ro"
      - "./key.pem:/tls/key.pem:ro"
  nginx:
    image: ${env.NGINX_IMAGE}
    ports: ["127.0.0.1::443"]
    volumes:
      - "./nginx.conf:/etc/nginx/conf.d/default.conf:ro"
      - "./cert.pem:/tls/cert.pem:ro"
      - "./key.pem:/tls/key.pem:ro"
    depends_on:
      relay: {condition: service_healthy}
`)
  console.log(JSON.stringify({ phase: 'compose-start', project, platform: lock.platform }))
  started = true; compose('up', '-d', '--wait', '--wait-timeout', '90'); passedStartup = true
  const port = service => Number(compose('port', service, '443').split(':').at(-1))
  const ca = readFileSync(resolve(directory, 'cert.pem'))
  const https = (gateway, path, body, headers = {}) => new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', servername: 'task14.localhost', port: port(gateway), path, ca, method: body ? 'POST' : 'GET', headers: { Host: 'task14.localhost', ...body ? { 'Content-Type': 'application/json', Origin: 'https://task14.localhost' } : {}, ...headers }, timeout: 5000 }, res => { let text = ''; res.on('data', chunk => { text += chunk }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, value: JSON.parse(text) })) })
    req.on('error', reject); req.on('timeout', () => req.destroy(new Error('HTTPS timeout'))); req.end(body ? JSON.stringify(body) : undefined)
  })
  const peer = async (gateway, path, headers) => {
    const ws = new WebSocket(`wss://127.0.0.1:${port(gateway)}${path}`, { ca, servername: 'task14.localhost', headers: { Host: 'task14.localhost', ...headers } }), queue = []
    ownedPeers.push(ws); ws.on('error', () => {}); ws.on('message', raw => queue.push(JSON.parse(raw.toString())))
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
    return { ws, send: value => ws.send(JSON.stringify(value)), next: async type => { for (let i = 0; i < 100; i++) { const index = queue.findIndex(message => message.type === type); if (index >= 0) return queue.splice(index, 1)[0]; await sleep(20) }; throw new Error('Missing ' + type) } }
  }
  const instanceId = randomUUID(), deviceSecret = randomBytes(32).toString('base64url'), linkSecret = randomBytes(32).toString('base64url'), enrollmentSecret = readFileSync(resolve(directory, 'secrets/enrollment'), 'utf8').trim(), linkVerifier = createHash('sha256').update(linkSecret).digest('hex')
  for (const gateway of ['caddy', 'nginx']) assert.equal((await https(gateway, '/health/ready')).status, 200)
  assert.equal((await https('caddy', '/v1/devices/register', { enrollmentSecret, instanceId, deviceSecret, linkVerifier, authEpoch: 1 })).status, 201)
  let lastCookie
  const connect = async gateway => {
    const login = await https(gateway, `/v1/instances/${instanceId}/login`, { secret: linkSecret }); assert.equal(login.status, 200)
    lastCookie = login.headers['set-cookie'][0].split(';')[0]
    const host = await peer(gateway, '/v1/host', { Authorization: 'Bearer ' + deviceSecret, 'X-DSH-Instance': instanceId })
    host.send({ v: 1, type: 'host.hello', instanceId, runtimeId: randomUUID(), versions: [1], capabilities: [], authEpoch: 1, linkVerifier, enabled: true }); await host.next('relay.ack')
    const browser = await peer(gateway, `/v1/instances/${instanceId}/control`, { Cookie: lastCookie, Origin: 'https://task14.localhost' })
    browser.send({ v: 1, type: 'browser.hello', versions: [1] }); const lease = await browser.next('browser.lease'); browser.send({ v: 1, type: 'browser.lease-ack', id: lease.id })
    const attach = await host.next('attach'); host.send({ v: 1, type: 'host.attached', id: attach.id, fence: attach.fence }); await browser.next('ready')
    assert.equal((await https(gateway, `/v1/instances/${instanceId}/logout`, {}, { Cookie: lastCookie })).status, 200)
    await Promise.all([host.ws, browser.ws].map(ws => ws.readyState === WebSocket.CLOSED ? Promise.resolve() : new Promise(resolve => { ws.once('close', resolve); ws.close() })))
    await sleep(200); console.log(JSON.stringify({ phase: 'https-wss-ready', gateway }))
  }
  await connect('caddy'); await connect('nginx')
  const evidence = compose('exec', '-T', 'relay', 'node', '--input-type=module', '-e', "import fs from 'node:fs';import Database from 'better-sqlite3';const db=new Database('/data/relay.sqlite');console.log(JSON.stringify({uid:process.getuid(),gid:process.getgid(),secretMode:fs.statSync('/run/secrets/enrollment').mode&511,node:process.version,platform:process.platform,arch:process.arch,sqlite:db.prepare('select sqlite_version() v').get().v,devices:db.prepare('select count(*) n from devices').get().n,corePackages:fs.readdirSync('/app/node_modules').filter(name=>name.startsWith('@deepseek'))}));db.close()")
  const facts = JSON.parse(evidence); assert.notEqual(facts.uid, 0); assert.equal(facts.secretMode, 0o600); assert.equal(facts.devices, 1); assert.equal(facts.platform, 'linux'); assert.deepEqual(facts.corePackages, [])
  console.log(JSON.stringify({ phase: 'non-root-native-secret-volume', ...facts }))
  const freshCookie = async () => { const login = await https('caddy', `/v1/instances/${instanceId}/login`, { secret: linkSecret }); assert.equal(login.status, 200); const token = login.headers['set-cookie'][0].split(';')[0]; assert.equal((await https('caddy', `/v1/instances/${instanceId}/control-status`, {}, { Cookie: token })).status, 200); return token }
  const backupCookie = await freshCookie()
  compose('exec', '-T', 'relay', 'node', 'dist/cli.js', 'backup', '--destination', '/data/pre-upgrade.sqlite')
  let refused = false
  try { compose('exec', '-T', 'relay', 'node', 'dist/cli.js', 'restore', '--backup', '/data/pre-upgrade.sqlite') } catch { refused = true }
  assert(refused, 'Restore must refuse live process lock')
  let removalRefused = false
  try { compose('exec', '-T', 'relay', 'node', 'dist/cli.js', 'remove-device', '--instance', instanceId) } catch { removalRefused = true }
  assert(removalRefused, 'Removal must refuse live process lock')
  compose('restart', 'relay'); await sleep(1000)
  for (let i = 0; i < 60; i++) { try { if ((await https('caddy', '/health/ready')).status === 200) break } catch {}; await sleep(250); if (i === 59) throw new Error('Restart not ready') }
  await connect('caddy') // durable registration survived restart/volume reuse
  const previousImage = process.env.WEB_CONTROL_PREVIOUS_RELAY_IMAGE
  if (previousImage) {
    assert.match(previousImage, /^sha256:[a-f0-9]{64}$/)
    assert.notEqual(previousImage, env.RELAY_IMAGE)
    assert.equal(run('image', 'inspect', '--format', '{{.Id}}', previousImage), previousImage)
    // Exact task-owned same-schema candidate replacement; never a released-version claim.
    for (const image of [previousImage, env.RELAY_IMAGE]) {
      writeFileSync(resolve(directory, '.env'), Object.entries({ ...env, RELAY_IMAGE: image, CONTROL_DOMAIN: 'task14.localhost' }).map(([key, value]) => `${key}=${value}`).join('\n') + '\n', { mode: 0o600 })
      compose('up', '-d', '--wait', '--force-recreate', '--wait-timeout', '60', 'relay')
      assert.equal((await https('caddy', '/health/ready')).status, 200)
      assert.equal((await https('caddy', `/v1/instances/${instanceId}/control-status`, {}, { Cookie: backupCookie })).status, 200)
      await connect('caddy')
    }
    console.log(JSON.stringify({ phase: 'candidate-image-forward-backward', previousImage, currentImage: env.RELAY_IMAGE, schema: 1, releasedVersionUpgrade: 'NOT_RUN' }))
  } else console.log(JSON.stringify({ phase: 'candidate-image-forward-backward', status: 'NOT_RUN', reason: 'No exact owned previous image supplied' }))

  lastCookie = await freshCookie()
  compose('stop', 'relay')
  compose('run', '--rm', '--no-deps', 'relay', 'remove-device', '--instance', instanceId)
  compose('up', '-d', '--wait', '--wait-timeout', '60', 'relay')
  assert.equal((await https('caddy', `/v1/instances/${instanceId}/login`, { secret: linkSecret })).status, 401)
  assert.equal((await https('caddy', `/v1/instances/${instanceId}/control-status`, {}, { Cookie: lastCookie })).status, 401)
  let revokedHost = false
  try { await peer('caddy', '/v1/host', { Authorization: 'Bearer ' + deviceSecret, 'X-DSH-Instance': instanceId }) } catch { revokedHost = true }
  assert(revokedHost, 'Revoked Host must be rejected after restart')
  compose('stop', 'relay')
  compose('run', '--rm', '--no-deps', 'relay', 'restore', '--backup', '/data/pre-upgrade.sqlite')
  compose('up', '-d', '--wait', '--wait-timeout', '60', 'relay')
  assert.equal((await https('caddy', `/v1/instances/${instanceId}/control-status`, {}, { Cookie: backupCookie })).status, 200) // restoring an older snapshot can revive relay-only revoked sessions
  await connect('nginx')
  compose('stop', 'relay')
  compose('run', '--rm', '--no-deps', '--volume', `${directory}/secrets:/secrets`, 'relay', 'rotate-enrollment', '--secret-file', '/secrets/enrollment')
  const rotated = readFileSync(resolve(directory, 'secrets/enrollment'), 'utf8').trim()
  assert.notEqual(rotated, enrollmentSecret)
  compose('up', '-d', '--wait', '--force-recreate', '--wait-timeout', '60', 'relay')
  const registration = secret => ({ enrollmentSecret: secret, instanceId: randomUUID(), deviceSecret, linkVerifier, authEpoch: 1 })
  assert.equal((await https('caddy', '/v1/devices/register', registration(enrollmentSecret))).status, 401)
  assert.equal((await https('caddy', '/v1/devices/register', registration(rotated))).status, 201)
  await connect('caddy') // enrollment rotation preserves already-enrolled device credentials
  console.log(JSON.stringify({ phase: 'offline-enrollment-rotation-recreated', project }))
  console.log(JSON.stringify({ phase: 'restart-backup-restore-passed', project }))
  completed = true
} finally {
  for (const ws of ownedPeers) ws.terminate()
  if (started && !passedStartup) { try { console.error(compose('logs', '--no-log-prefix', '--tail', '20', 'nginx')) } catch {} }
  if (started) { compose('down', '--volumes', '--remove-orphans'); console.log(JSON.stringify({ phase: 'exact-project-cleanup', project })) }
  rmSync(directory, { recursive: true, force: true })
}
assert(completed)
console.log('Isolated deployment smoke PASS; public cellular/Desktop acceptance NOT_RUN')
