/** Bounded public WAN trial: fresh stock Web profile, existing packed plugin, normal TLS trust. */
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm, stat, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { arch, platform, release } from 'node:os'
import { chromium, expect } from '@playwright/test'
import { stopOwned } from './owned-child.mjs'
const root = resolve(import.meta.dirname, '..'), sha = bytes => createHash('sha256').update(bytes).digest('hex')
const option = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1] }
const publicOrigin = new URL(option('--origin') ?? '').origin, enrollmentFile = resolve(option('--enrollment-file') ?? '')
assert(publicOrigin.startsWith('https://'), 'HTTPS origin required')
assert((await stat(enrollmentFile)).mode % 512 === 384, 'enrollment file must be 0600')
assert(!process.env.NODE_TLS_REJECT_UNAUTHORIZED || process.env.NODE_TLS_REJECT_UNAUTHORIZED === '1', 'normal TLS trust required')
const stockNode = process.execPath, node24 = process.execPath
assert(!['NODE_EXTRA_CA_CERTS','SSL_CERT_FILE','SSL_CERT_DIR','NODE_USE_ENV_PROXY'].some(key => process.env[key]), 'custom TLS/proxy environment forbidden')
assert(process.execPath === stockNode, 'run with pinned stock Node26')
const runtime = join(root, 'data/compat/runtime-0.2.0-rc.2'), cli = join(runtime, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
const pnpm = (process.env.WEB_CONTROL_PNPM_CLI ?? process.env.npm_execpath ?? join(root,'node_modules/pnpm/bin/pnpm.mjs'))
const dir = await mkdtemp(join(root, 'data/public-trial-')), home = join(dir, 'home'), profile = join(home, 'profiles/web')
await mkdir(home); await mkdir(join(dir, 'bin'))
const env = { PATH: join(dir, 'bin') + ':/usr/bin:/bin:/opt/homebrew/bin', HOME: home, DSH_HOME: home, TMPDIR: process.env.TMPDIR, DSH_TELEMETRY_DISABLED: '1', NO_COLOR: '1', NPM_CONFIG_CACHE: join(dir, 'npm-cache'), XDG_CACHE_HOME: join(dir, 'cache') }
await writeFile(join(dir, 'bin/pnpm'), `#!/bin/sh\nexec '${node24}' '${pnpm}' "$@"\n`, { mode: 0o700 })
const manifest = JSON.parse(await readFile(join(root, 'dist/release/manifest.json'), 'utf8'))
const sourceFiles = [...manifest.buildSources, 'scripts/public-trial.mjs', 'scripts/owned-child.mjs']
const snapshot = { capturedAt: new Date().toISOString(), buildInputs: manifest.images.buildInputs, files: await Promise.all(sourceFiles.map(async path => ({ path, sha256: sha(await readFile(join(root, path))) }))) }
assert(sha(snapshot.files.slice(0, 83).map(f => f.path + '\0' + f.sha256).join('\n')) === 'e562dad94f66c2f113a321dffe1eb9f5effa69d936e6c461e31bafa3130038a1', 'unchanged product inputs required')
await writeFile(join(dir, 'source-snapshot.json'), JSON.stringify(snapshot, null, 2))
const evidence = { format: 1, status: 'RUNNING', runnerPid: process.pid, argv: process.argv, source: execFileSync('git', ['rev-parse', 'HEAD'], {cwd:root, encoding:'utf8'}).trim(), startedAt: new Date().toISOString(), environment: `${platform()} ${release()} ${arch()}`, publicOrigin, buildInputs: snapshot.buildInputs, desktop: 'NOT_RUN', physicalPhone: false, trust: { defaultTLS: true, customCA: false, ignoreHTTPSErrors: false }, projectNode: execFileSync(node24, ['--version'], {encoding:'utf8'}).trim(), stockNode: process.version, checks: [], ownedChildren: [], processes: [], viewports: [], wss: [], prompt: undefined }
const invocation = { capturedAtRun: true, source: 'actual runner entry', childPid: process.pid, argv: process.argv, startedAt: evidence.startedAt, sourceSnapshotSha256: sha(await readFile(join(dir, 'source-snapshot.json'))) }
await writeFile(join(dir, 'invocation.json'), JSON.stringify(invocation, null, 2))
console.log(JSON.stringify({status:'RUNNING', runnerPid:process.pid, directory:dir}))
const logs = [], secrets = [], children = []; let host, browser, localOrigin, cookie, registration, pending, fixtureDone = false
const check = (name, ok) => { evidence.checks.push({name,ok}); assert(ok, name) }
const owned = async (command, args, role, cwd = root) => {
  const child = spawn(command, args, {cwd, env, stdio:['ignore','pipe','pipe']}); children.push(child)
  evidence.ownedChildren.push({role,pid:child.pid,executable:command,argv:child.spawnargs,startedAt:new Date().toISOString()})
  await writeFile(join(dir, 'owned-processes.json'), JSON.stringify(evidence.ownedChildren, null, 2))
  return child
}
const rpc = async (method, args) => {
  const res = await fetch(localOrigin + '/api/' + method, {method:'POST',headers:{'content-type':'application/json',origin:localOrigin,cookie},body:JSON.stringify({type:'client-request',rpcId:randomUUID(),method,payload:{args}}),signal:AbortSignal.timeout(method === 'web-control/probe' ? 240000 : 30000)})
  const reply = await res.json(); assert(res.ok && reply.result?.ok, 'local RPC failed: ' + method); return reply.result.value
}
const manage = args => rpc('web-control/manage', args)
const finishFixture = async () => {
  if (!pending || fixtureDone) return
  await writeFile(join(profile, '.web-control-ui-done.json'), '{"done":true}\n')
  const result = await pending; fixtureDone = true
  evidence.nativeUI = JSON.parse(await readFile(join(profile, '.web-control-ui-state.json'), 'utf8'))
  evidence.nativeUICleanup = JSON.parse(await readFile(join(profile, '.web-control-ui-cleanup.json'), 'utf8'))
  check('native-two-turns', result.supported && evidence.nativeUI.starts === 2 && evidence.nativeUI.approvals === 2 && evidence.nativeUI.stops === 2)
  check('native-fixture-cleanup', evidence.nativeUICleanup.clean && evidence.nativeUICleanup.pendingModelStreams === 0)
}
try {
  const lock = JSON.parse(await readFile(join(runtime, 'package-lock.json'), 'utf8')).packages['node_modules/@deepseek-ai/dsh']
  evidence.releaseIntegrity = lock.integrity
  check('pinned-public-runtime', lock.version === '0.2.0-rc.2' && lock.resolved.startsWith('https://registry.npmjs.org/') && lock.integrity === 'sha512-EAJ3gPNcVt/uv8X19PMm9NkVhWgT7xXNMk0UKCVm+IQ5rpSQOcsMUa0HWlnYYVybKMsccjcRB21vVVsaXQ6IdA==')
  const tar = await fetch(lock.resolved, {signal:AbortSignal.timeout(30000)}); assert(tar.ok)
  check('public-runtime-tarball-sri', 'sha512-' + createHash('sha512').update(Buffer.from(await tar.arrayBuffer())).digest('base64') === lock.integrity)
  evidence.pluginSha256 = sha(await readFile(join(root, 'dist/release/dsh-web-control-0.0.0-compat.1.tgz')))
  check('unchanged-packed-plugin', evidence.pluginSha256 === '970b03b545488daa881b6f27a3dad727c1b4c141e900791e8c47acc9599a1bd1')
  const readiness = await fetch(publicOrigin + '/health/ready', {signal:AbortSignal.timeout(30000)})
  evidence.https = {url:readiness.url,status:readiness.status,ready:await readiness.json()}; check('normal-trust-public-https', readiness.status === 200 && evidence.https.ready.ok === true)
  await copyFile(join(root, 'dist/release/dsh-web-control-0.0.0-compat.1.tgz'), join(dir, 'plugin.tgz'))
  const install = await owned(stockNode, [cli,'plugin','--profile','web','add',join(dir,'plugin.tgz')], 'plugin-install')
  install.stdout.on('data', c=>logs.push(String(c))); install.stderr.on('data', c=>logs.push(String(c)))
  const code = await new Promise((done,reject)=>{const timer=setTimeout(()=>reject(new Error('owned install timeout')),90000);install.once('error',error=>{clearTimeout(timer);reject(error)});install.once('close',code=>{clearTimeout(timer);done(code)})})
  check('public-cli-install', code === 0)
  await writeFile(join(profile, '.web-control-compat.json'), '{"isolated":true,"captureCoreResolution":true,"task15UI":true}\n')
  host = await owned(stockNode, [cli,'web','--no-open','--host','127.0.0.1','--port','0'], 'isolated-stock-web', dir)
  const address = await new Promise((done,reject)=>{
    let output=''; const timer=setTimeout(()=>reject(new Error('owned Web startup timeout')),90000)
    const consume=c=>{output+=c;logs.push(String(c));const m=output.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/);if(m){clearTimeout(timer);done(m[1])}}
    host.stdout.on('data',consume);host.stderr.on('data',consume);host.once('error',reject);host.once('exit',()=>{clearTimeout(timer);reject(new Error('owned Web exited before startup'))})
  })
  secrets.push(new URL(address).searchParams.get('token')); localOrigin = new URL(address).origin
  const login = await fetch(address,{redirect:'manual'}); cookie=login.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ')
  check('stock-startup-disabled', (await manage({action:'status'})).status.phase === 'disabled')
  const enrollment = (await readFile(enrollmentFile,'utf8')).trim(); secrets.push(enrollment)
  registration = await manage({action:'configure',relayOrigin:publicOrigin,enrollmentSecret:enrollment})
  for(let i=0;i<150&&!registration.link;i++){await new Promise(r=>setTimeout(r,100));registration=await manage({action:'link'})}
  assert(registration.link, 'registration link unavailable')
  const link=new URL(registration.link); secrets.push(new URLSearchParams(link.hash.slice(1)).get('key')); evidence.instanceId=registration.status.instanceId
  check('same-public-origin', link.origin === publicOrigin)
  pending=rpc('web-control/probe',{}); void pending.catch(()=>{})
  let fixture
  for(let i=0;i<150;i++){try{fixture=JSON.parse(await readFile(join(profile,'.web-control-ui-state.json'),'utf8'));if(fixture.state==='ready')break}catch{}await new Promise(r=>setTimeout(r,100))}
  check('native-fixture-ready',fixture?.state==='ready'); evidence.sessionId=fixture.sessionId
  browser=await chromium.launch({executablePath:process.env.WEB_CONTROL_CHROMIUM_EXECUTABLE,headless:true,env})
  evidence.browser={name:'Chrome',version:browser.version(),physicalPhone:false}
  const context=await browser.newContext({locale:'en-US',viewport:{width:1280,height:900}}), remote=await context.newPage(), errors=[]
  remote.on('pageerror',e=>errors.push(e.message))
  remote.on('websocket', ws=>{
    const proof={url:ws.url(),sent:[],received:[],closed:false}; evidence.wss.push(proof)
    ws.on('framesent',f=>{if(typeof f.payload!=='string')return;try{const m=JSON.parse(f.payload);proof.sent.push(m.type);if(m.type==='call'&&m.command?.op==='session.prompt')evidence.prompt={sessionId:m.command.sessionId,op:m.command.op,requestId:m.command.requestId,content:m.command.content}}catch{}})
    ws.on('framereceived',f=>{if(typeof f.payload!=='string')return;try{proof.received.push(JSON.parse(f.payload).type)}catch{}})
    ws.on('close',()=>{proof.closed=true})
  })
  await remote.goto(registration.link)
  await expect(remote.getByRole('status',{name:'连接状态'})).toHaveText('已连接',{timeout:20000})
  await remote.locator('.session-list').getByRole('button',{name:'Task15 native session',exact:true}).click()
  await expect(remote.getByRole('button',{name:'允许一次',exact:true})).toBeEnabled({timeout:15000}); await remote.getByRole('button',{name:'允许一次',exact:true}).click()
  await expect(remote.locator('.message.live')).toContainText('Task15 native live output',{timeout:15000})
  check('same-original-native-session',new URL(remote.url()).searchParams.get('session')===fixture.sessionId)
  for(const width of [390,1280]){await remote.setViewportSize({width,height:900});await expect.poll(()=>remote.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);evidence.viewports.push({width,height:900,noOverflow:true});await remote.screenshot({path:join(dir,`public-${width}.png`)})}
  const second=await context.newPage(); await second.goto(registration.link); await expect(second.getByRole('status',{name:'连接状态'})).toHaveText('已有远程页面连接，请关闭原页面后重试重试连接',{timeout:15000});await second.close();check('one-active-controller',true)
  await remote.reload();await expect(remote.getByRole('status',{name:'连接状态'})).toHaveText('已连接',{timeout:20000});check('public-wss-reconnect',evidence.wss.length>=2)
  await expect(remote.getByRole('button',{name:'停止',exact:true})).toBeEnabled({timeout:15000});await remote.getByRole('button',{name:'停止',exact:true}).click();await expect(remote.getByRole('button',{name:'停止',exact:true})).toBeDisabled({timeout:15000})
  await remote.getByLabel('添加附件').setInputFiles({name:'public-trial.txt',mimeType:'text/plain',buffer:Buffer.from('Task17 public WAN native upload')})
  await expect(remote.getByText('public-trial.txt · 已上传')).toBeVisible({timeout:15000})
  await remote.getByRole('textbox',{name:'消息',exact:true}).fill('Task17 public WAN prompt');await remote.getByRole('button',{name:'发送',exact:true}).click();await expect(remote.getByText('消息已由本机接受')).toBeVisible({timeout:15000})
  await expect(remote.getByRole('button',{name:'允许一次',exact:true})).toBeEnabled({timeout:15000});await remote.getByRole('button',{name:'允许一次',exact:true}).click();await expect(remote.locator('.message.live')).toContainText('Task15 native live output',{timeout:15000})
  await remote.getByRole('button',{name:'停止',exact:true}).click();await expect(remote.getByRole('button',{name:'停止',exact:true})).toBeDisabled({timeout:15000})
  check('uploaded-prompt-same-session',evidence.prompt?.sessionId===fixture.sessionId && evidence.prompt.content.some(p=>p.kind==='upload' && p.name==='public-trial.txt' && typeof p.receiptId==='string'))
  check('native-ui-console-clean',errors.length===0)
  await remote.close();await browser.close();browser=undefined;evidence.browserClosed=true
  await finishFixture()
  const resolutions=JSON.parse(await readFile(join(profile,'.web-control-core-resolution.json'),'utf8'))
  evidence.coreResolution={count:Object.keys(resolutions).length,singlePublicRuntime:(await Promise.all(Object.entries(resolutions).map(async([entry,value])=>value.startsWith(await realpath(join(runtime,'node_modules',entry.split('/').slice(0,2).join('/'))))))).every(Boolean)}
  check('single-public-core-runtime',evidence.coreResolution.count===12 && evidence.coreResolution.singlePublicRuntime)
  check('normal-trust-public-wss',evidence.wss.every(w=>w.url===`${publicOrigin.replace('https:','wss:')}/v1/instances/${evidence.instanceId}/control`) && evidence.wss.some(w=>w.received.includes('ready') && w.sent.includes('call')))
  evidence.status='PASS'
} catch(error) {evidence.status='FAIL';evidence.failure=error.message}
finally {
  try {await browser?.close();evidence.browserClosed=true;await finishFixture()} catch(error){evidence.status='FAIL';evidence.fixtureCleanupFailure=error.message}
  if(registration){try{await manage({action:'stop'});check('owned-instance-disabled',(await manage({action:'status'})).status.phase==='disabled');const key=new URLSearchParams(new URL(registration.link).hash.slice(1)).get('key');const res=await fetch(`${publicOrigin}/v1/instances/${evidence.instanceId}/login`,{method:'POST',headers:{'content-type':'application/json',origin:publicOrigin},body:JSON.stringify({secret:key}),signal:AbortSignal.timeout(15000)});evidence.revocation={status:res.status,code:(await res.json()).error?.code};check('owned-instance-revoked',evidence.revocation.code==='AUTH_REVOKED')}catch(error){evidence.status='FAIL';evidence.revocationFailure=error.message}}
  for(const child of children){try{await stopOwned(child);evidence.processes.push({pid:child.pid,exitCode:child.exitCode,signal:child.signalCode})}catch(error){evidence.status='FAIL';evidence.cleanupFailure=error.message}}
  // The caller owns the input secret file. The trial removes all secrets stored in its fresh profile.
  await rm(home,{recursive:true,force:true}); evidence.ownedHomeRemoved=true
  const redact=value=>secrets.reduce((text,secret)=>secret?text.replaceAll(secret,'[redacted]'):text,String(value)).replace(/([?&]token=)[^\s]+/g,'$1[redacted]')
  evidence.finishedAt=new Date().toISOString(); invocation.finishedAt=evidence.finishedAt;invocation.exitCode=evidence.status==='PASS'?0:1
  await writeFile(join(dir,'invocation.json'),redact(JSON.stringify(invocation,null,2)))
  await writeFile(join(dir,'run.log'),redact(logs.join('\n')))
  await writeFile(join(dir,'evidence.json'),redact(JSON.stringify(evidence,null,2))+'\n')
  console.log(JSON.stringify({status:evidence.status,evidence:join(dir,'evidence.json'),failure:evidence.failure ? redact(evidence.failure) : undefined}));if(evidence.status!=='PASS')process.exitCode=1
}
