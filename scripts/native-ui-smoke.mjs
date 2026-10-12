/** Candidate image + real stock Host hot upgrade/rollback. Every process/profile is owned. */
import {spawn} from 'node:child_process'
import {createHash,randomUUID,X509Certificate} from 'node:crypto'
import {mkdtemp,mkdir,readFile,writeFile,chmod,unlink} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {createServer} from 'node:net'
import {request as httpsRequest} from 'node:https'
import {chromium,expect} from '@playwright/test'
import ts from 'typescript'
import {verifyCandidate} from './native-ui-candidate.mjs'
import {stopOwned} from './owned-child.mjs'
const root=resolve(import.meta.dirname,'..'),sha=b=>createHash('sha256').update(b).digest('hex')
const stockNode=process.execPath,pnpm=(process.env.WEB_CONTROL_PNPM_CLI ?? process.env.npm_execpath ?? join(root,'node_modules/pnpm/bin/pnpm.mjs'))
const runtime=join(root,'data/compat/runtime-0.2.0-rc.2'),cli=join(runtime,'node_modules/@deepseek-ai/dsh/lib/bin.js')
const sleep=ms=>new Promise(r=>setTimeout(r,ms))
async function freePort(){const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));return port}
export async function smokeCandidate(manifestPath){
 const{manifest:m,directory:candidate}=await verifyCandidate(manifestPath)
 const dir=await mkdtemp(join(root,'data/native-ui-release-smoke-')),home=join(dir,'home'),bin=join(dir,'bin'),data=join(dir,'database'),project='dsh-native-smoke-'+randomUUID().slice(0,8)
 for(const path of[home,bin,data])await mkdir(path)
 await writeFile(join(bin,'pnpm'),'#!/bin/sh\nexec '+stockNode+' '+pnpm+' "$@"\n');await chmod(join(bin,'pnpm'),0o755)
 const env={...process.env,PATH:bin+':'+process.env.PATH,HOME:home,DSH_HOME:home,DOCKER_CONFIG:process.env.DOCKER_CONFIG??join(process.env.HOME,'.docker'),DSH_TELEMETRY_DISABLED:'1',NPM_CONFIG_CACHE:join(dir,'npm-cache'),XDG_CACHE_HOME:join(dir,'cache'),NODE_EXTRA_CA_CERTS:join(dir,'cert.pem')}
 const processes=[],logs=[],secrets=[],checks=[],pageErrors=[],csp=[];let host,browser,composeStarted=false
 const compose=['compose','--project-name',project,'-f',join(dir,'compose.yaml')]
 const evidence={schema:1,status:'RUNNING',directory:dir,runnerSha256:sha(await readFile(import.meta.filename)),candidateManifestSha256:sha(await readFile(manifestPath)),sourceDigest:m.sourceDigest,artifactDigest:m.artifactDigest,image:m.image,plugin:m.plugin,uiRevision:m.ui.revision,checks,processes,desktop:'NOT_RUN',production:'NOT_RUN',pageErrors,csp}
 const record=child=>{const row={pid:child.pid,executable:child.spawnfile,ended:false};processes.push(row);child.once('close',()=>{row.ended=true})}
 const run=async(exe,args)=>{const child=spawn(exe,args,{cwd:root,env,stdio:['ignore','pipe','pipe']});record(child);let output='';child.stdout.on('data',v=>{output+=v});child.stderr.on('data',v=>logs.push(String(v)));const code=await new Promise((r,j)=>{child.once('error',j);child.once('close',r)});if(code!==0){logs.push(output);throw new Error('Owned command failed: '+exe+' '+args[0])}return output.trim()}
 const check=(name,ok)=>{checks.push({name,ok});if(!name.startsWith('resource:')&&!name.startsWith('head:'))console.log(JSON.stringify({smoke:name,ok}));if(!ok)throw new Error('Smoke check failed: '+name)}
 const poll=async(fn)=>{const end=Date.now()+45000;let last;while(Date.now()<end){try{const value=await fn();if(value)return value}catch(error){last=error}await sleep(200)}throw last??new Error('Owned fixture readiness timeout')}
 try{
  const port=await freePort(),origin=`https://native-ui.test:${port}`,hostOrigin=`https://127.0.0.1:${port}`
  await run('/usr/bin/openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(dir,'key.pem'),'-out',join(dir,'cert.pem'),'-days','1','-subj','/CN=native-ui.test','-addext','subjectAltName=DNS:native-ui.test,IP:127.0.0.1']);await chmod(join(dir,'key.pem'),0o600)
  await run('docker',['run','--rm','--platform',m.image.platform,'--network','none','--user',`${process.getuid()}:${process.getgid()}`,'--mount',`type=bind,src=${data},dst=/data`,m.image.id,'init','--secret-file','/data/enrollment'])
  const enrollment=(await readFile(join(data,'enrollment'),'utf8')).trim();secrets.push(enrollment)
  const nginx=JSON.parse(await readFile(join(root,'deploy/images.lock.json'),'utf8')).images.nginx
  if(!/^docker\.io\/library\/nginx:[a-z-]+@sha256:[a-f0-9]{64}$/.test(nginx))throw new Error('Pinned nginx image required')
  await writeFile(join(dir,'nginx.conf'),`events {}\nhttp { server { listen 443 ssl; server_name native-ui.test; ssl_certificate /tls/cert.pem; ssl_certificate_key /tls/key.pem; location / { proxy_pass http://relay:8787; proxy_http_version 1.1; proxy_set_header Host $http_host; proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade"; proxy_buffering off; proxy_buffer_size 16k; proxy_buffers 8 16k; proxy_read_timeout 3600s; } } }\n`)
  await writeFile(join(dir,'compose.yaml'),`services:\n  relay:\n    image: ${m.image.id}\n    platform: ${m.image.platform}\n    user: "${process.getuid()}:${process.getgid()}"\n    environment:\n      PUBLIC_ORIGIN: ${JSON.stringify(origin)}\n      DATABASE_PATH: /data/relay.sqlite\n      ENROLLMENT_SECRET_FILE: /data/enrollment\n    volumes:\n      - ${JSON.stringify(data+':/data')}\n  proxy:\n    image: ${nginx}\n    ports:\n      - "127.0.0.1:${port}:443"\n    volumes:\n      - ${JSON.stringify(join(dir,'nginx.conf')+':/etc/nginx/nginx.conf:ro')}\n      - ${JSON.stringify(join(dir,'cert.pem')+':/tls/cert.pem:ro')}\n      - ${JSON.stringify(join(dir,'key.pem')+':/tls/key.pem:ro')}\n`)
  composeStarted=true;await run('docker',[...compose,'up','-d','--wait','--wait-timeout','60'])
  const ca=await readFile(join(dir,'cert.pem'))
  const probe=(path,method='GET')=>new Promise((done,reject)=>{const request=httpsRequest({host:'127.0.0.1',port,path,method,ca,servername:'native-ui.test',headers:{Host:new URL(origin).host}},response=>{const chunks=[];response.on('data',b=>chunks.push(b));response.on('end',()=>done({status:response.statusCode,headers:response.headers,body:Buffer.concat(chunks)}))});request.on('error',reject);request.setTimeout(15000,()=>request.destroy(new Error('Probe timeout')));request.end()})
  check('candidate-ready-through-tls-nginx',(await probe('/health/ready')).status===200)
  const catalog=await probe('/ui-release.json');check('public-release-manifest-hash',sha(catalog.body)===m.ui.sha256)
  const ui=JSON.parse(catalog.body);for(const item of ui.assets){const response=await probe(item.url);check('resource:'+item.url,response.status===200&&sha(response.body)===item.sha256);const head=await probe(item.url,'HEAD');check('head:'+item.url,head.status===200&&head.body.length===0&&Number(head.headers['content-length'])===item.bytes)}
  check('unlisted-resource-rejected',(await probe('/ui/unlisted.js')).status===404)
  const main=await probe('/');check('strict-csp-through-nginx',main.status===200&&String(main.headers['content-security-policy']).length>4096&&!/unsafe-(eval|inline)/.test(main.headers['content-security-policy']))
  const fixture=join(dir,'fixture/package');await mkdir(fixture,{recursive:true})
  const source=await readFile(join(root,'packages/plugin/src/compat/native-ui-fixture.ts'),'utf8');evidence.fixtureSha256=sha(source)
  await writeFile(join(fixture,'index.js'),ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2024,module:ts.ModuleKind.ESNext}}).outputText)
  await writeFile(join(fixture,'package.json'),JSON.stringify({name:'web-control-native-release-fixture',version:'0.0.0',type:'module',main:'./index.js',dsh:{bundle:{patch:['./cordis.patch.yml']}},peerDependencies:{'@deepseek-ai/cordis':'~4.0.4','@deepseek-ai/dsh':'0.2.0-rc.2'}}))
  await writeFile(join(fixture,'cordis.patch.yml'),'- insert:\n    - id: web-control-native-release-fixture\n      name: web-control-native-release-fixture\n');await run('/usr/bin/tar',['-czf',join(dir,'fixture.tgz'),'-C',join(dir,'fixture'),'package'])
  await run(stockNode,[cli,'plugin','--profile','web','add',join(candidate,m.rollback.pluginPath)]);await run(stockNode,[cli,'plugin','--profile','web','add',join(dir,'fixture.tgz')])
  await writeFile(join(home,'profiles/web/.web-control-compat.json'),JSON.stringify({isolated:true,nativeUi:true}))
  host=spawn(stockNode,[cli,'web','--no-open','--host','127.0.0.1','--port','0'],{cwd:dir,env,stdio:['ignore','pipe','pipe']});record(host)
  const address=await new Promise((r,j)=>{let text='';const timer=setTimeout(()=>j(new Error('Stock Host timeout')),90000);const consume=b=>{text+=b;const match=text.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/);if(match){clearTimeout(timer);r(match[1])}};host.stdout.on('data',consume);host.stderr.on('data',consume);host.once('exit',()=>{clearTimeout(timer);j(new Error('Owned Host exited'))})});secrets.push(address)
  const localOrigin=new URL(address).origin,login=await fetch(address,{redirect:'manual'}),cookie=login.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');secrets.push(cookie)
  const request=(path,init={})=>fetch(localOrigin+path,{...init,headers:{...init.headers,cookie,origin:localOrigin},signal:AbortSignal.timeout(45000)})
  const rpc=async(method,args)=>{const response=await request('/api/'+method,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:randomUUID(),method,payload:{args}})}),reply=await response.json();if(!reply.result?.ok)throw new Error('Owned RPC failed: '+method);return reply.result.value}
  const setup=await(await request('/api/web-control/native-ui/setup',{method:'POST'})).json()
  const initial=await rpc('web-control/manage',{action:'configure',relayOrigin:hostOrigin,enrollmentSecret:enrollment});await rpc('web-control/manage',{action:'start'})
  const first=await rpc('web-control/manage',{action:'link'});secrets.push(first.link)
  const link=new URL(first.link);link.hostname='native-ui.test';secrets.push(link.href)
  browser=await chromium.launch({headless:true,executablePath:process.env.WEB_CONTROL_CHROMIUM_EXECUTABLE,args:['--host-resolver-rules=MAP native-ui.test 127.0.0.1','--no-proxy-server','--ignore-certificate-errors-spki-list='+createHash('sha256').update(new X509Certificate(ca).publicKey.export({type:'spki',format:'der'})).digest('base64')]})
  const context=await browser.newContext({ignoreHTTPSErrors:true,locale:'zh-CN'});await context.addInitScript(()=>window.addEventListener('securitypolicyviolation',event=>{(window.__smokeCsp??=[]).push({directive:event.effectiveDirective,blocked:event.blockedURI})}))
  const open=async(url)=>{const page=await context.newPage();page.on('pageerror',e=>pageErrors.push(e.message));await page.goto(url);return page}
  const oldPage=await open(link.href),legacy=oldPage.frameLocator('iframe');await expect(legacy.getByRole('status',{name:'连接状态'})).toContainText('已连接',{timeout:30000})
  check('old-host-selects-frozen-legacy',await oldPage.locator('iframe').count()===1)
  // A synthetic task is started in the untouched local UI, independent of remote ownership.
  const local=await open(address);await local.getByRole('dialog',{name:'预览版说明'}).getByRole('button',{name:'继续',exact:true}).click();await local.getByRole('treeitem',{name:/Native UI verification/}).click()
  await local.getByRole('textbox',{name:/发消息或创建任务/}).fill('Native release independent task');await local.getByRole('button',{name:'发送消息',exact:true}).click();await local.getByRole('button',{name:'允许一次',exact:true}).click()
  const counts=async()=>await(await request('/api/web-control/native-ui/status')).json();await poll(async()=>{const c=await counts();return c.starts===1&&c.stops===0})
  await local.evaluate(()=>{window.__nativeReleaseMarker='same-renderer'})
  const replace=async(path,kind)=>{
   const removed=await rpc('pluginManager/removeBundle',{name:'dsh-web-control'});check(kind+'-remove-applied',removed.changed===true&&removed.application==='applied')
   const installed=await rpc('pluginManager/installBundle',{spec:path});check(kind+'-install-applied',installed.changed===true&&installed.application==='applied')
   const ready=await poll(async()=>{const state=await rpc('web-control/manage',{action:'status'});return state.status.phase==='ready'&&state})
   check(kind+'-instance-preserved',ready.status.instanceId===initial.status.instanceId);const latest=await rpc('web-control/manage',{action:'link'});check(kind+'-link-preserved',latest.link===first.link)
   const c=await counts();check(kind+'-task-preserved',c.starts===1&&c.stops===0);check(kind+'-renderer-preserved',await local.evaluate(()=>window.__nativeReleaseMarker)==='same-renderer')
  }
  await replace(join(candidate,m.plugin.path),'upgrade')
  await expect(oldPage.locator('iframe')).toHaveCount(0,{timeout:15000})
  const native=await open(link.href);await expect(native.getByRole('treeitem',{name:/Native UI verification/})).toBeVisible({timeout:30000});await native.getByRole('treeitem',{name:/Native UI verification/}).click();await expect(native.getByText('Native UI seeded history',{exact:true})).toBeVisible();check('native-entry-direct-mount',await native.locator('iframe').count()===0)
  const legacyOnNew=await open(origin+`/connect/${initial.status.instanceId}?legacy=${ui.legacy.revision}`);await expect(legacyOnNew.getByRole('status',{name:'连接状态'})).toContainText('已连接',{timeout:30000});check('frozen-browser-new-host-compatible',true);await legacyOnNew.close()
  await replace(join(candidate,m.rollback.pluginPath),'rollback')
  const restored=await open(link.href);await expect(restored.frameLocator('iframe').getByRole('status',{name:'连接状态'})).toContainText('已连接',{timeout:30000});check('rollback-legacy-ui-restored',true)
  for(const page of [oldPage,native,restored,local])for(const frame of page.frames())csp.push(...await frame.evaluate(()=>window.__smokeCsp??[]))
  check('page-errors-empty',pageErrors.length===0);check('product-csp-empty',csp.length===0)
  evidence.counts=await counts();evidence.sessionId=setup.sessionId;evidence.status='PASS'
 }catch(error){evidence.status='FAIL';evidence.error=String(error);evidence.pages=await Promise.all((browser?.contexts().flatMap(c=>c.pages())??[]).map(async page=>{try{return await page.locator('body').ariaSnapshot()}catch{return 'Page unavailable'}}));throw error}finally{
  await browser?.close();await stopOwned(host)
  if(composeStarted){try{await run('docker',[...compose,'down','--volumes','--remove-orphans']);evidence.containerCleanup=true}catch(error){evidence.containerCleanup=false;evidence.status='FAIL';evidence.cleanupError=String(error)}}
  for(const path of[join(dir,'key.pem'),join(data,'enrollment')])await unlink(path).catch(()=>{})
  evidence.hostExited=!host||host.exitCode!==null||host.signalCode!==null
  let log=logs.join('\n');for(const secret of secrets)if(secret)log=log.split(secret).join('[REDACTED]');await writeFile(join(dir,'log.txt'),log)
  await writeFile(join(dir,'evidence.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify({smokeDirectory:dir,status:evidence.status}))
 }
 if(evidence.status!=='PASS'||!evidence.containerCleanup||!evidence.hostExited||processes.some(p=>!p.ended))throw new Error('Smoke cleanup incomplete')
 return{directory:dir,status:evidence.status,checks:checks.length}
}
