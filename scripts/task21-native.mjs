/** Task21 bounded plugin3/new-Web read-only stock smoke. No Desktop or upgrade actions. */
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, chmod, symlink, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { createServer } from 'node:tls';
import { connect as connectTcp } from 'node:net';
import { chromium, expect } from '@playwright/test';
import { stopOwned } from './owned-child.mjs';
const root = resolve(import.meta.dirname, '..'), candidate = join(root, 'data/task21/candidate');
const stockNode = process.execPath, projectNode = process.execPath;
const pnpm = (process.env.WEB_CONTROL_PNPM_CLI ?? process.env.npm_execpath ?? join(root,'node_modules/pnpm/bin/pnpm.mjs'));
const runtime = join(root, 'data/compat/runtime-0.2.0-rc.2'), cli = join(runtime, 'node_modules/@deepseek-ai/dsh/lib/bin.js');
const hash = value => createHash('sha256').update(value).digest('hex');
const fixtureCode = `
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session/types';
import { randomUUID } from 'node:crypto';
import { readFile,mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
export const name='task21-native-fixture';
export const inject=['connection','profileContext','typertGateway','sessions','llm'];
export function apply(ctx){let starts=0,stops=0,agentId;const lifetime=new AbortController();ctx.effect(()=>()=>lifetime.abort());const invoke=(namespace,method,request)=>ctx.typertGateway.invoke({namespace,method,args:{request}});
class Synthetic extends LlmAdapter{async listModels(provider){return[{provider,id:'synthetic',name:'Task21 isolated',inputModalities:['text']}]}async resolveModel(provider,id){return{provider,id,name:'Task21 isolated',inputModalities:['text']}}async *stream(options){if(options.purpose){yield{type:'finish',reason:{kind:'stop'}};return}starts++;const signal=AbortSignal.any([lifetime.signal,...options.signal?[options.signal]:[]]);try{yield{type:'block-start',index:0,blockType:'text'};yield{type:'text-delta',index:0,text:'Task21 independent native task'};await new Promise(resolve=>{if(signal.aborted)resolve();else signal.addEventListener('abort',resolve,{once:true})});signal.throwIfAborted()}finally{stops++}}}
ctx.effect(()=>ctx.llm.registerAdapter(['task21-independent'],new Synthetic()));
for(const method of ['setup','status','version'])ctx.connection.fetch.register({path:'/api/task21-native/'+method,methods:['POST'],requestBody:'buffered',async fetch(request){await readFile(join(ctx.profileContext.dir,'.task21-owned'));const message=await request.json();let value;if(method==='status')value={starts,stops,agentId};if(method==='version'){const require=createRequire(import.meta.url);const entry=require.resolve('dsh-web-control');value={version:JSON.parse(require('node:fs').readFileSync(join(entry,'../../package.json'),'utf8')).version}}if(method==='setup'){const path=join(ctx.profileContext.dir,'task21-workspace');await mkdir(path,{recursive:true});const workspaceId=(await invoke('workspace','create',{path})).workspace.workspaceId;const historyId=(await invoke('session','create',{workspaceId})).sessionId;await invoke('session','rename',{sessionId:historyId,title:'Task21 read-only history'});const session=ctx.sessions.get(SessionId(historyId));if(!session)throw new Error('native session not live');session.append('user/message',{id:randomUUID(),role:'user',source:{kind:'user'},content:[{type:'text',text:'Task21 owned read-only session smoke'}]},{surfaceOp:'append'});await ctx.parallel('session/flush',session);agentId=(await invoke('session','create',{workspaceId})).sessionId;await invoke('session','selectModel',{sessionId:agentId,provider:'task21-independent',model:'synthetic'});await invoke('session','rename',{sessionId:agentId,title:'Task21 unrelated running task'});await invoke('session','prompt',{sessionId:agentId,requestId:randomUUID(),mode:'queue',content:[{type:'text',text:'Task21 owned synthetic task'}]});for(let i=0;i<100&&starts===0;i++)await new Promise(resolve=>setTimeout(resolve,20));value={historyId,workspaceId}}return Response.json({type:'server-response',rpcId:message.rpcId,result:{ok:true,value}})}})
}
`;

if (process.argv.includes('--relay')) {
  const dir = process.argv.at(-1), { startRelay } = await import(join(candidate, 'relay/dist/server.js'));
  let relay; const sockets = new Set();
  const tls = createServer({ key: await readFile(join(dir, 'key.pem')), cert: await readFile(join(dir, 'cert.pem')) }, incoming => {
    const upstream = connectTcp(relay.port, '127.0.0.1'); sockets.add(incoming); sockets.add(upstream);
    incoming.on('error', () => upstream.destroy()); upstream.on('error', () => incoming.destroy());
    incoming.on('close', () => { sockets.delete(incoming); upstream.destroy() }); upstream.on('close', () => { sockets.delete(upstream); incoming.destroy() }); incoming.pipe(upstream).pipe(incoming);
  });
  await new Promise(done => tls.listen(0, '127.0.0.1', done)); const origin = `https://localhost:${tls.address().port}`;
  relay = await startRelay({ publicOrigin: origin, listenHost: '127.0.0.1', port: 0, databasePath: join(dir, 'relay.sqlite'), staticDir: join(candidate, 'web'), enrollmentVerifier: hash(await readFile(join(dir, 'enrollment'), 'utf8')), heartbeatMs: 1000, leaseTtlMs: 5000, limits: { jsonBytes:262144, chunkBytes:65536, fileBytes:33554432, calls:16, streams:16, uploads:2, bufferedBytes:4194304, callTimeoutMs:30000, transferIdleMs:60000 } });
  await writeFile(join(dir, 'relay-ready.json'), JSON.stringify({ origin, pid: process.pid }));
  process.once('SIGTERM', async () => { const drains = [...sockets].map(socket => new Promise(done => socket.once('close', done))); for (const socket of sockets) socket.destroy(); await relay.close(); await new Promise(done => tls.close(done)); await Promise.all(drains); await writeFile(join(dir, 'relay-cleanup.json'), JSON.stringify({ sockets: sockets.size, relayClosed: true, tlsClosed: true })); process.exit(0) });
} else {
  const dir = await mkdtemp(join(root, 'data/task21/native-')), home = join(dir, 'home'); await mkdir(home);
  const bin = join(dir, 'bin'); await mkdir(bin); await writeFile(join(bin, 'pnpm'), '#!/bin/sh\nexec '+stockNode+' '+pnpm+' "$@"\n'); await chmod(join(bin, 'pnpm'), 0o755);
  const env = { PATH: bin + ':' + process.env.PATH, HOME: home, DSH_HOME: home, TMPDIR: process.env.TMPDIR, DSH_TELEMETRY_DISABLED: '1', NO_COLOR: '1', NPM_CONFIG_CACHE: join(dir, 'npm-cache'), XDG_CACHE_HOME: join(dir, 'cache'), NODE_EXTRA_CA_CERTS: join(dir, 'cert.pem') };
  const manifest = JSON.parse(await readFile(join(candidate, 'manifest.json'), 'utf8'));
  for (const file of [...manifest.web, ...manifest.retained, manifest.installedPlugin]) if (hash(await readFile(join(candidate, file.path))) !== file.sha256) throw new Error('Candidate input mismatch');
  const evidence = { status: 'RUNNING', startedAt: new Date().toISOString(), argv: process.argv, runnerPid: process.pid, runnerSha256: hash(await readFile(import.meta.filename)), directory: dir, sourceDigest: manifest.sourceDigest, webDigest: manifest.webDigest, pluginSha256: manifest.installedPlugin.sha256, checks: [], processes: [], desktop: 'NOT_RUN' };
  console.log(JSON.stringify({ directory: dir, pid: process.pid }));
  let host, relayChild, browser, origin, cookie; const logs = [], secrets = [];
  const save = () => writeFile(join(dir, 'evidence.json'), JSON.stringify(evidence, null, 2));
  const check = (name, ok) => { evidence.checks.push({ name, ok }); if (!ok) throw new Error(name) };
  const record = child => { const item = { pid: child.pid, executable: child.spawnfile, argv: child.spawnargs, startedAt: new Date().toISOString() }; evidence.processes.push(item); child.once('close', (exit, signal) => { item.endedAt = new Date().toISOString(); item.exit = exit; item.signal = signal }); return item };
  const run = async (command, args) => { const child = spawn(command, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] }); record(child); let output = ''; child.stdout.on('data', bytes => output += bytes); child.stderr.on('data', bytes => output += bytes); const code = await new Promise((done, reject) => { child.once('error', reject); child.once('close', done) }); logs.push(output); if (code !== 0) throw new Error('Owned command failed: ' + args[0]) };
  const rpc = async (method, args) => { const response = await fetch(origin + '/api/' + method, { method: 'POST', headers: { 'content-type':'application/json', origin, cookie }, body: JSON.stringify({ type:'client-request', rpcId: randomUUID(), method, payload:{ args } }), signal: AbortSignal.timeout(90000) }); const reply = await response.json(); if (!response.ok || !reply.result?.ok) throw new Error('RPC ' + method + ': ' + reply.result?.error?.code); return reply.result.value };
  try {
    await symlink(join(root, 'packages/relay/node_modules'), join(candidate, 'relay/node_modules')).catch(error => { if (error.code !== 'EEXIST') throw error });
    await writeFile(join(dir, 'cert.cnf'), '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyCertSign,keyEncipherment\n');
    await run('/usr/bin/openssl', ['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(dir,'key.pem'),'-out',join(dir,'cert.pem'),'-days','1','-config',join(dir,'cert.cnf')]);
    const enrollment = randomBytes(32).toString('base64url'); secrets.push(enrollment); await writeFile(join(dir, 'enrollment'), enrollment, { mode: 0o600 });
    const fixture = join(dir, 'fixture-package/package'); await mkdir(fixture, { recursive: true });
    await writeFile(join(fixture, 'package.json'), JSON.stringify({ name:'task21-native-fixture', version:'0.0.0', type:'module', main:'./index.js', files:['index.js','cordis.patch.yml'], dsh:{ bundle:{ patch:['./cordis.patch.yml'] } }, peerDependencies:{ '@deepseek-ai/cordis':'~4.0.4', '@deepseek-ai/dsh':'0.2.0-rc.2' } }));
    await writeFile(join(fixture, 'cordis.patch.yml'), '- insert:\n    - id: task21-native-fixture\n      name: task21-native-fixture\n'); await writeFile(join(fixture, 'index.js'), fixtureCode);
    await run('/usr/bin/tar', ['-czf',join(dir,'fixture.tgz'),'-C',join(dir,'fixture-package'),'package']);
    await run(stockNode, [cli,'plugin','--profile','web','add',join(candidate,'dsh-web-control-0.0.0-compat.3.tgz')]); await run(stockNode, [cli,'plugin','--profile','web','add',join(dir,'fixture.tgz')]);
    await writeFile(join(home, 'profiles/web/.task21-owned'), 'isolated\n');
    relayChild = spawn(projectNode, [import.meta.filename, '--relay', dir], { cwd: root, env, stdio:['ignore','pipe','pipe'] }); record(relayChild); relayChild.stdout.on('data', data => logs.push(String(data))); relayChild.stderr.on('data', data => logs.push(String(data)));
    let relay; for(let i=0;i<100;i++){ try{ relay=JSON.parse(await readFile(join(dir,'relay-ready.json'),'utf8')); break }catch{} await new Promise(done=>setTimeout(done,50)) } check('owned-relay-ready', !!relay);
    host=spawn(stockNode,[cli,'web','--no-open','--host','127.0.0.1','--port','0'],{cwd:dir,env,stdio:['ignore','pipe','pipe']}); record(host);
    const address=await new Promise((done,reject)=>{ let output=''; const timer=setTimeout(()=>reject(new Error('Stock Web startup timeout')),90000); const consume=bytes=>{output+=bytes;const match=output.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/);if(match){clearTimeout(timer);done(match[1])}};host.stdout.on('data',consume);host.stderr.on('data',consume);host.once('exit',()=>{clearTimeout(timer);logs.push(output);reject(new Error('Stock Web exited'))}) });
    secrets.push(new URL(address).searchParams.get('token')); origin=new URL(address).origin; const login=await fetch(address,{redirect:'manual'});cookie=login.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
    const setup=await rpc('task21-native/setup',{}); evidence.native=setup;
    check('plugin3-installed',(await rpc('task21-native/version',{})).version==='0.0.0-compat.3');
    const configured=await rpc('web-control/manage',{action:'configure',relayOrigin:relay.origin,enrollmentSecret:enrollment}); check('plugin3-host-ready',configured.status.phase==='ready');
    const before=await rpc('task21-native/status',{}); check('native-task-starts1-stops0',before.starts===1&&before.stops===0);
    const link=await rpc('web-control/manage',{action:'link'}); secrets.push(new URL(link.link).hash.slice(5));
    browser=await chromium.launch({headless:true,env,executablePath:process.env.WEB_CONTROL_CHROMIUM_EXECUTABLE}); evidence.browser={name:'Chrome',version:browser.version(),executable:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'};
    const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1280,height:900}}), page=await context.newPage(), errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(link.link); await expect(page.getByRole('status',{name:'连接状态'})).toHaveText('已连接',{timeout:20000}); await page.getByRole('button',{name:'Task21 read-only history',exact:true}).click(); await expect(page.getByText('Task21 owned read-only session smoke',{exact:true})).toBeVisible();
    await page.reload(); await expect(page.getByRole('status',{name:'连接状态'})).toHaveText('已连接',{timeout:20000}); await expect(page.getByText('Task21 owned read-only session smoke',{exact:true})).toBeVisible(); check('readonly-session-survives-browser-reconnect',true);
    const after=await rpc('task21-native/status',{}); check('native-task-keeps-starts1-stops0',after.starts===1&&after.stops===0&&after.agentId===before.agentId); evidence.nativeBefore=before;evidence.nativeAfter=after;check('browser-errors-empty',errors.length===0);evidence.browserErrors=errors;
    const screenshot=join(dir,'plugin3-readonly-new-web.png');await page.screenshot({path:screenshot});evidence.screenshot=screenshot;evidence.status='PASS';
  }catch(error){evidence.status='FAIL';evidence.error=error instanceof Error?error.message:String(error);console.error(evidence.error)}finally{await browser?.close();await stopOwned(host);await stopOwned(relayChild);await unlink(join(candidate,'relay/node_modules')).catch(()=>{});await unlink(join(dir,'key.pem')).catch(()=>{});await unlink(join(dir,'enrollment')).catch(()=>{});evidence.finishedAt=new Date().toISOString();evidence.cleanup={browserClosed:true,hostExited:!host||host.exitCode!==null||host.signalCode!==null,relayExited:!relayChild||relayChild.exitCode!==null||relayChild.signalCode!==null};await save();let log=logs.join('\n');for(const secret of secrets)if(secret)log=log.split(secret).join('[REDACTED]');await writeFile(join(dir,'log.txt'),log);console.log(JSON.stringify({status:evidence.status,directory:dir,checks:evidence.checks.length}));if(evidence.status!=='PASS')process.exitCode=1}
}
