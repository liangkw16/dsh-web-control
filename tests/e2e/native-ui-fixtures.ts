import { test as base, expect, type Page, type BrowserContext, type Browser } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:https'
import { request as httpRequest } from 'node:http'
import { connect } from 'node:net'
import { lookup } from 'node:dns/promises'
import { mkdtemp, mkdir, readFile, writeFile, chmod, unlink } from 'node:fs/promises'
import { join, resolve, extname } from 'node:path'
import { createHash, randomBytes, X509Certificate } from 'node:crypto'
import ts from 'typescript'
import { build } from 'vite'
import { startRelay } from '../../packages/relay/src/server.ts'
import { hashSecret } from '../../packages/relay/src/auth.ts'
import { DEFAULT_LIMITS } from '../../packages/protocol/src/index.ts'
import { collectUiArtifacts } from '../../scripts/native-ui-artifacts.mjs'
import { buildNativeStartup } from '../../scripts/native-ui-startup.mjs'
import { assembleUiRelease } from '../../scripts/native-ui-resources.mjs'
import { stopOwned } from '../../scripts/owned-child.mjs'
const root=resolve(import.meta.dirname,'../..'),runtime=join(root,'data/compat/runtime-0.2.0-rc.2')
const node=process.execPath,stockNode=process.execPath
const pnpm=(process.env.WEB_CONTROL_PNPM_CLI ?? process.env.npm_execpath ?? join(root,'node_modules/pnpm/bin/pnpm.mjs'))
const cli=join(runtime,'node_modules/@deepseek-ai/dsh/lib/bin.js')
const sha=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex')
export const nativeInput=(page:Page)=>page.getByRole('textbox',{name:/^(发消息或创建任务, \/ 调用指令, @ 文件或对话|Cmd\/Ctrl\+Enter 插话发送全部排队消息)$/})
export const diagnostic=process.env.NATIVE_UI_DIAGNOSTIC==='1'
export interface NativeFixture {
  sessionId:string;dir:string;localPage:Page;nativePage:Page
  seedRunning():Promise<{sessionId:string}>
  counts(sessionId:string):Promise<{starts:number;stops:number;prompts:number}>
  status():Promise<any>
  openRemote():Promise<Page>
  preference(mode:'queue'|'steer'):Promise<void>
  scenario(mode:'questions'|'files'):Promise<void>
  expectBootFailure(page:Page,code:string):Promise<void>
  disconnectRemote():Promise<void>
  restoreRemote():Promise<void>
  pendingInteractions():Promise<number>
  seedHistory():Promise<void>
  seedArtifacts():Promise<void>
  documents(files:Record<string,Buffer|null>,update?:boolean):Promise<void>
  revokeFiles():Promise<void>
  fileBoundary():Promise<{outside:string;upstreamOutsideRead:boolean}>
  seedManagement():Promise<{workspaceId:string;originalWorkspaceId:string;peer:string}>
  shutdown():Promise<void>
}
export const test=base.extend<{nativeFixture:NativeFixture;nativePage:Page;localPage:Page}>({
  nativeFixture:[async({browserName,playwright},use,testInfo)=>{
    const browserHost=browserName==='webkit'?'127.0.0.1.nip.io':'native-ui.test'
    if(browserHost!=='native-ui.test'&&(await lookup(browserHost)).address!=='127.0.0.1')throw new Error('Fixture hostname must resolve to loopback')
    await mkdir(join(root,'data/native-ui'),{recursive:true})
    const dir=await mkdtemp(join(root,'data/native-ui/core-')),home=join(dir,'home'),bin=join(dir,'bin')
    await mkdir(home);await mkdir(bin)
    await writeFile(join(bin,'pnpm'),'#!/bin/sh\nexec '+stockNode+' '+pnpm+' "$@"\n');await chmod(join(bin,'pnpm'),0o755)
    const env={PATH:bin+':'+process.env.PATH,HOME:home,DSH_HOME:home,TMPDIR:process.env.TMPDIR,DSH_TELEMETRY_DISABLED:'1',NO_COLOR:'1',NPM_CONFIG_CACHE:join(dir,'npm-cache'),XDG_CACHE_HOME:join(dir,'cache'),NODE_EXTRA_CA_CERTS:join(dir,'cert.pem')}
    let browser:Browser|undefined
    let host:ChildProcess|undefined,relay:Awaited<ReturnType<typeof startRelay>>|undefined,tls:ReturnType<typeof createServer>|undefined
    let controllerOffline=false
    const controllerSockets=new Set<import('node:stream').Duplex>()
    const contexts:BrowserContext[]=[],remotePages:Page[]=[],expectedBootFailures=new Map<Page,string>(),sockets=new Set<import('node:stream').Duplex>(),processes:any[]=[],secrets:string[]=[],logs:string[]=[],errors:string[]=[],browserErrors:string[]=[]
    const evidence:any={status:'RUNNING',test:testInfo.title,browser:browserName,directory:dir,stage:process.env.NATIVE_UI_STAGE??(diagnostic?'core-diagnostic':'core'),releaseGate:diagnostic?'NOT_EVALUATED':'PENDING',desktop:'NOT_RUN',production:'NOT_RUN',processes}
    evidence.sourceSha256=Object.fromEntries(await Promise.all(['scripts/native-ui-gates.mjs','tests/e2e/native-ui.config.ts','scripts/native-ui-compat.mjs','scripts/native-ui-startup.mjs','scripts/native-ui-resources.mjs','packages/web/src/transport.ts','packages/web/src/entry.ts','packages/web/src/main.ts','packages/web/src/page-lifecycle.ts','packages/web/src/drafts.ts','packages/relay/src/ui-assets.ts','packages/relay/src/server.ts','tests/e2e/native-ui-fixtures.ts','tests/e2e/native-current-documents.ts','tests/e2e/native-ui-entry.ts','tests/e2e/native-ui-core.spec.ts','tests/e2e/native-ui-parity.spec.ts','tests/e2e/native-ui-recovery.spec.ts','tests/e2e/native-ui-mobile.spec.ts','tests/e2e/native-ui-parity.config.ts','packages/web/src/native-ui/mobile.css','packages/plugin/src/compat/native-ui-fixture.ts',...['file-media','media-response','media-worker','media-install','file-routes','files','management-routes','preferences','workspace-rc2','bootstrap','cleanup','extension','history','recorded-schedule','draft-binding','blocks','locales','rpc-rc2','generation','read-routes','write-routes','prompt-attempts','interaction-routes','upload-routes'].map(name=>'packages/web/src/native-ui/'+name+'.ts')].map(async path=>[path,sha(await readFile(join(root,path)))])))
    console.log(JSON.stringify({directory:dir,stage:evidence.stage}))
    const record=(child:ChildProcess)=>{const row={pid:child.pid,executable:child.spawnfile,argv:child.spawnargs,ended:false};processes.push(row);child.once('close',()=>{row.ended=true})}
    const run=async(executable:string,args:string[],cwd=root)=>{const child=spawn(executable,args,{cwd,env,stdio:['ignore','pipe','pipe']});record(child);child.stdout.on('data',b=>logs.push(String(b)));child.stderr.on('data',b=>logs.push(String(b)));const code=await new Promise((r,j)=>{child.once('error',j);child.once('close',r)});if(code!==0)throw new Error('Owned fixture command failed: '+args[0])}
    let closed=false
    const shutdown=async()=>{
      if(closed)return;closed=true
      for(const context of contexts)await context.close().catch(e=>errors.push(String(e)))
      for(const s of sockets)s.destroy()
      if(tls)await new Promise<void>(r=>tls!.close(()=>r()))
      await relay?.close().catch(e=>errors.push(String(e)))
      await stopOwned(host).catch(e=>errors.push(String(e)))
      await browser?.close().catch(()=>{})
      await unlink(join(dir,'key.pem')).catch(()=>{})
      evidence.cleanup={sockets:sockets.size,hostExited:!host||host.exitCode!==null||host.signalCode!==null};evidence.cleanupErrors=errors
      let log=logs.join('\n');for(const secret of secrets)if(secret)log=log.split(secret).join('[REDACTED]')
      await writeFile(join(dir,'log.txt'),log);await writeFile(join(dir,'evidence.json'),JSON.stringify(evidence,null,2))
    }
    try{
      await writeFile(join(dir,'cert.cnf'),'[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=native-ui.test\n[ext]\nsubjectAltName=DNS:native-ui.test,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyCertSign,keyEncipherment\n')
      await run('/usr/bin/openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(dir,'key.pem'),'-out',join(dir,'cert.pem'),'-days','1','-config',join(dir,'cert.cnf')])
      // Trust only this owned short-lived key for Chromium service-worker fetches;
      // context ignoreHTTPSErrors alone does not cover worker installation.
      const spki=createHash('sha256').update(new X509Certificate(await readFile(join(dir,'cert.pem'))).publicKey.export({type:'spki',format:'der'})).digest('base64')
      browser=await playwright[browserName].launch(browserName==='chromium'?{executablePath:process.env.WEB_CONTROL_CHROMIUM_EXECUTABLE,args:['--host-resolver-rules=MAP native-ui.test 127.0.0.1','--no-proxy-server','--ignore-certificate-errors-spki-list='+spki]}:{})
      const fixture=join(dir,'fixture/package');await mkdir(fixture,{recursive:true})
      const source=await readFile(join(root,'packages/plugin/src/compat/native-ui-fixture.ts'),'utf8')
      evidence.fixtureSha256=sha(source)
      await writeFile(join(fixture,'index.js'),ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2024,module:ts.ModuleKind.ESNext}}).outputText)
      await writeFile(join(fixture,'package.json'),JSON.stringify({name:'web-control-native-ui-fixture',version:'0.0.0',type:'module',main:'./index.js',dsh:{bundle:{patch:['./cordis.patch.yml']}},peerDependencies:{'@deepseek-ai/cordis':'~4.0.4','@deepseek-ai/dsh':'0.2.0-rc.2','@deepseek-ai/dsh-session-projection':'0.2.0-rc.2'}}))
      await writeFile(join(fixture,'cordis.patch.yml'),'- insert:\n    - id: remote-schedule-ui\n      name: \'@deepseek-ai/dsh-client-ui-schedule\'\n    - id: web-control-native-ui-fixture\n      name: web-control-native-ui-fixture\n- id: session-query-sqlite\n  config:\n    path: ":memory:"\n    openAt: first-search\n')
      await run('/usr/bin/tar',['-czf',join(dir,'fixture.tgz'),'-C',join(dir,'fixture'),'package'])
      await run(node,[pnpm,'--filter','dsh-web-control','build'])
      await run(node,[pnpm,'--filter','dsh-web-control','pack','--pack-destination',dir])
      const metadata=JSON.parse(await readFile(join(root,'packages/plugin/package.json'),'utf8'))
      const packed=join(dir,`dsh-web-control-${metadata.version}.tgz`);evidence.pluginSha256=sha(await readFile(packed))
      await run(stockNode,[cli,'plugin','--profile','web','add',packed])
      await run(stockNode,[cli,'plugin','--profile','web','add',join(dir,'fixture.tgz')])
      await writeFile(join(home,'profiles/web/.web-control-compat.json'),JSON.stringify({isolated:true,nativeUi:true}))
      host=spawn(stockNode,[cli,'web','--no-open','--host','127.0.0.1','--port','0'],{cwd:dir,env,stdio:['ignore','pipe','pipe']});record(host)
      const address=await new Promise<string>((r,j)=>{let text='';const timer=setTimeout(()=>j(new Error('Owned Host startup timeout')),90000);const consume=(b:Buffer)=>{text+=b;const match=text.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/);if(match){clearTimeout(timer);r(match[1])}};host!.stdout!.on('data',consume);host!.stderr!.on('data',consume);host!.once('exit',()=>{clearTimeout(timer);logs.push(text);j(new Error('Owned Host exited'))})})
      secrets.push(new URL(address).searchParams.get('token')!);const origin=new URL(address).origin
      const login=await fetch(address,{redirect:'manual'}),cookie=login.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');secrets.push(cookie)
      const request:typeof fetch=(url,init={})=>fetch(url,{...init,headers:{...init.headers,cookie,origin},signal:AbortSignal.timeout(90000)})
      const native=await(await request(origin+'/api/web-control/native-ui/setup',{method:'POST'})).json();evidence.native=native
      if(testInfo.title==='stock native UI reads real history and sends through the packaged Host and Relay'){
        const seeded=await request(origin+'/api/web-control/native-ui/large',{method:'POST'});if(!seeded.ok)throw new Error('Large native projection fixture failed: '+(await seeded.text()).slice(0,2048));evidence.largeProjection=await seeded.json()
      }
      const artifacts=await collectUiArtifacts({runtimeRoot:runtime,outputDir:join(dir,'artifacts'),fixtureOrigin:origin,fetch:request})
      const startup=await buildNativeStartup({runtimeRoot:runtime,outputDir:join(dir,'startup')});evidence.startup=startup
      const entry=join(root,'tests/e2e/native-ui-entry.ts')
      await build({configFile:false,root,logLevel:'error',build:{outDir:join(dir,'entry'),emptyOutDir:true,lib:{entry,formats:['es'],fileName:()=> 'entry.js'},rollupOptions:{output:{inlineDynamicImports:true}}}})
      await writeFile(join(dir,'entry/index.html'),'<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="dsh-ui-release" content="1"><link rel="icon" href="data:,"><link rel="stylesheet" href="/dsh-web-control-workspace.css"></head><body><div id="root"></div><script type="module" src="/entry.js"></script></body></html>')
      const release=await assembleUiRelease({artifactsDir:join(dir,'artifacts'),startupDir:join(dir,'startup'),webDir:join(dir,'entry'),legacyDir:join(root,'tests/fixtures/legacy-release'),outputDir:join(dir,'release')})
      const revision=release.native[0].revision;evidence.uiRevision=revision;evidence.releaseManifestSha256=sha(await readFile(join(dir,'release/ui-release.json')))
      const served=new Set<string>();evidence.loadedAssets=[];evidence.styleHashCount=release.inlineStyles.length
      let csp=''
      tls=createServer({key:await readFile(join(dir,'key.pem')),cert:await readFile(join(dir,'cert.pem'))},(req,res)=>{
        if(controllerOffline&&req.url?.endsWith('/status')){res.writeHead(503).end();return}
        if(!relay){res.writeHead(503).end();return}
        const proxy=httpRequest({host:'127.0.0.1',port:relay.port,path:req.url,method:req.method,headers:req.headers,maxHeaderSize:32768},up=>{
          if(up.headers['content-security-policy'])csp=String(up.headers['content-security-policy'])
          const asset=release.assets.find(item=>item.url===req.url)
          if(asset&&!served.has(asset.url)){served.add(asset.url);evidence.loadedAssets.push({url:asset.url,sha256:asset.sha256,bytes:asset.bytes})}
          if(diagnostic&&up.headers['content-security-policy']){up.headers['content-security-policy-report-only']=up.headers['content-security-policy'];delete up.headers['content-security-policy']}
          res.writeHead(up.statusCode!,up.headers);up.pipe(res)
        })
        proxy.on('error',()=>res.destroy());req.on('aborted',()=>proxy.destroy());req.pipe(proxy)
      })
      tls.on('connection',s=>{sockets.add(s);s.once('close',()=>sockets.delete(s))})
      tls.on('upgrade',(req,socket,head)=>{if(!relay||(controllerOffline&&req.url?.endsWith('/control'))){socket.destroy();return}if(req.url?.endsWith('/control')){controllerSockets.add(socket);socket.once('close',()=>controllerSockets.delete(socket))}const upstream=connect(relay.port,'127.0.0.1');sockets.add(upstream);upstream.once('close',()=>sockets.delete(upstream));upstream.on('error',()=>socket.destroy());socket.on('error',()=>upstream.destroy());socket.on('close',()=>upstream.destroy());upstream.on('connect',()=>{upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n`+req.rawHeaders.reduce((s,h,i,a)=>i%2?s:s+h+': '+a[i+1]+'\r\n','')+'\r\n');if(head.length)upstream.write(head);socket.pipe(upstream).pipe(socket)})})
      await new Promise<void>(r=>tls!.listen(0,'127.0.0.1',r));const port=(tls.address() as {port:number}).port,remoteOrigin=`https://${browserHost}:${port}`,hostRelayOrigin=`https://127.0.0.1:${port}`
      const enrollmentSecret=randomBytes(32).toString('base64url');secrets.push(enrollmentSecret)
      relay=await startRelay({publicOrigin:remoteOrigin,listenHost:'127.0.0.1',port:0,databasePath:join(dir,'relay.sqlite'),enrollmentVerifier:hashSecret(enrollmentSecret),staticDir:join(dir,'release'),heartbeatMs:1000,leaseTtlMs:5000,limits:DEFAULT_LIMITS})
      const manage=async(args:unknown)=>{const reply=await(await request(origin+'/api/web-control/manage',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:crypto.randomUUID(),method:'web-control/manage',payload:{args}})})).json();if(!reply.result?.ok)throw new Error('Management failed: '+reply.result?.error?.code);return reply.result.value}
      const managed=await manage({action:'configure',relayOrigin:hostRelayOrigin,enrollmentSecret});secrets.push(managed.link)
      await manage({action:'start'})
      const link=new URL(managed.link);link.hostname=browserHost;link.pathname+='/'
      const localContext=await browser!.newContext({locale:'zh-CN',ignoreHTTPSErrors:true});contexts.push(localContext)
      await localContext.addCookies(cookie.split('; ').map(part=>{const i=part.indexOf('=');return{name:part.slice(0,i),value:part.slice(i+1),url:origin}}))
      const localPage=await localContext.newPage();localPage.on('pageerror',e=>browserErrors.push('local: '+e.message));await localPage.goto(origin)
      const openRemote=async()=>{const context=await browser!.newContext({locale:'zh-CN',ignoreHTTPSErrors:true,viewport:{width:1280,height:900}});contexts.push(context);await context.addInitScript(()=>{Object.assign(globalThis,{__nativeCspViolations__:[]});window.addEventListener('securitypolicyviolation',event=>(globalThis as any).__nativeCspViolations__.push({directive:event.effectiveDirective,source:event.sourceFile,line:event.lineNumber,blocked:event.blockedURI,sample:event.sample}))});const page=await context.newPage();remotePages.push(page);page.on('pageerror',e=>browserErrors.push(e.message));page.on('console',m=>{if(m.type()==='error'||m.type()==='warning')logs.push(m.text())});if(testInfo.title==='native slow media initialization keeps the selected session synchronized')await context.addInitScript(()=>{
        const register=ServiceWorkerContainer.prototype.register
        ServiceWorkerContainer.prototype.register=async function(...args){const registration=await register.apply(this,args);await new Promise(resolve=>setTimeout(resolve,600));return registration}
      });await page.goto(link.href);return page}
      const nativePage=await openRemote()
      const counts=async(_id:string)=>{const c=await(await request(origin+'/api/web-control/native-ui/status')).json();return{starts:c.starts,stops:c.stops,prompts:c.prompts??c.starts}}
      const fixtureOwner:NativeFixture={documents:async(files,update)=>{const response=await request(origin+'/api/web-control/native-ui/documents',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({files:Object.fromEntries(Object.entries(files).map(([key,value])=>[key,value?.toString('base64')??null])),update})});if(!response.ok)throw new Error('Owned document seeding failed')},sessionId:native.sessionId,dir,localPage,nativePage,counts,openRemote,shutdown,status:async()=>await(await request(origin+'/api/web-control/native-ui/status')).json(),
        disconnectRemote:async()=>{controllerOffline=true;for(const socket of controllerSockets)socket.destroy()},
        revokeFiles:async()=>{const response=await request(origin+'/api/web-control/native-ui/revoke-files',{method:'POST'});if(!response.ok)throw new Error('Owned workspace detach failed')},
        fileBoundary:async()=>{const response=await request(origin+'/api/web-control/native-ui/file-boundary',{method:'POST'});if(!response.ok)throw new Error('Owned file boundary proof failed');return response.json()},
        restoreRemote:async()=>{controllerOffline=false},
        pendingInteractions:async()=>{const status=await(await request(origin+'/api/web-control/native-ui/status')).json();return status.pendingInteractions},
        seedManagement:async()=>{const reply=await request(origin+'/api/web-control/native-ui/management',{method:'POST'});if(!reply.ok)throw new Error('Management fixture failed');return await reply.json()},
        seedArtifacts:async()=>{const reply=await request(origin+'/api/web-control/native-ui/artifacts',{method:'POST'});if(!reply.ok)throw new Error('Artifact fixture failed')},
        seedHistory:async()=>{const reply=await request(origin+'/api/web-control/native-ui/history',{method:'POST'});if(!reply.ok)throw new Error('History fixture failed')},
        expectBootFailure:async(page,code)=>{await expect.poll(()=>page.evaluate(()=>(globalThis as any).__nativeFixtureBootError__)).toBe('ProtocolError: '+code);expectedBootFailures.set(page,'ProtocolError: '+code)},
        scenario:async mode=>{const r=await request(origin+'/api/web-control/native-ui/scenario',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({scenario:mode})});if(!r.ok)throw new Error('Fixture scenario failed')},
        preference:async mode=>{await request(origin+'/api/web-control/native-ui/preference',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({mode})})},
        seedRunning:async()=>{await nativePage.getByRole('treeitem',{name:/Native UI verification/}).click();await nativeInput(nativePage).fill('Native Relay synthetic task');await nativePage.getByRole('button',{name:'发送消息',exact:true}).click();await nativePage.getByRole('button',{name:'允许一次',exact:true}).click();await expect.poll(()=>counts(native.sessionId)).toMatchObject({starts:1,stops:0,prompts:1});return{sessionId:native.sessionId}},
      }
      await use(fixtureOwner);evidence.status=testInfo.status===testInfo.expectedStatus?(diagnostic?'DIAGNOSTIC_PASS':'PASS'):'FAIL'
      await writeFile(join(dir,'native-accessibility.txt'),await nativePage.locator('body').ariaSnapshot())
      evidence.pages=await Promise.all(remotePages.map(async page=>{await expect.poll(()=>page.evaluate(()=>!!((globalThis as any).__nativeFixtureOwner__||(globalThis as any).__nativeFixtureBootError__))).toBe(true);const observation=await page.evaluate(()=>({csp:(globalThis as any).__nativeCspViolations__,bootError:(globalThis as any).__nativeFixtureBootError__,inspection:(globalThis as any).__nativeFixtureOwner__?.inspection()}));return {...observation,expectedBootFailure:expectedBootFailures.get(page)}}))
      const rawCsp=evidence.pages.flatMap((page:any)=>page.csp)
      const expectedAttack=(v:any)=>testInfo.title==='native current documents use original renderers and preserve downloaded bytes'&&v.directive==='img-src'&&v.blocked==='https://example.invalid/private.png'&&v.source===''&&v.line===0&&v.sample===''
      evidence.expectedSecurityCsp=rawCsp.filter(expectedAttack)
      evidence.csp=rawCsp.filter((v:any)=>!expectedAttack(v));evidence.cspPolicy=csp
      evidence.releaseGate=evidence.csp.length?'BLOCKED_CSP':diagnostic?'NOT_EVALUATED':evidence.status
      evidence.counts=await counts(native.sessionId)
      evidence.calls=await nativePage.evaluate(()=>(globalThis as any).__nativeFixtureCalls__);evidence.browserErrors=browserErrors;await nativePage.screenshot({path:join(dir,'native-final.png')})
      evidence.screenshotCsp=(await nativePage.evaluate(()=>(globalThis as any).__nativeCspViolations__)).slice(evidence.pages[0].csp.length)
      for(const violation of evidence.screenshotCsp){expect(evidence.browser).toBe('webkit');expect(violation).toMatchObject({directive:'style-src-elem',blocked:'inline',source:''})}
      expect(browserErrors).toEqual([])
      if(!diagnostic)expect(evidence.csp).toEqual([])
      for(const page of evidence.pages){expect(page.bootError).toBe(page.expectedBootFailure);if(!page.bootError)expect(page.inspection).toMatchObject({loaders:1,react:1,cordis:1,roots:1})}
    }catch(error){evidence.status='FAIL';evidence.error=String(error);throw error}finally{await shutdown()}
  },{timeout:180000}],
  nativePage:async({nativeFixture},use)=>use(nativeFixture.nativePage),
  localPage:async({nativeFixture},use)=>use(nativeFixture.localPage),
})
export {expect}
