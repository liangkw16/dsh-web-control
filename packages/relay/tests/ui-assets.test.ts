import {expect,test} from 'vitest'
import {mkdtemp,mkdir,writeFile,rm,symlink} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,dirname} from 'node:path'
import {createHash} from 'node:crypto'
import {createServer} from 'node:http'
import {loadUiRelease,serveUiAsset,verifyUiRelease,type UiReleaseManifest} from '../src/ui-assets.ts'
import {startRelay} from '../src/server.ts'
import {hashSecret} from '../src/auth.ts'
import {DEFAULT_LIMITS} from '../../protocol/src/index.ts'
const revision='a'.repeat(64),legacy='b'.repeat(64)
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'native-assets-'))
 const values=[['/index.html','index.html','<html>native entry</html>'],['/legacy.html','legacy.html','<html>legacy</html>'],[`/ui/${revision}/ui-artifact-manifest.json`,`ui/${revision}/ui-artifact-manifest.json`,'{}'],[`/ui/${revision}/plugins/@dsh/client/chunk.js?rev=1`,`ui/${revision}/chunks/nested.js`,'export const value=1'],['/assets/old-12345678.css','assets/old-12345678.css','body{margin:0}'],['/assets/media-worker-12345678.js','assets/media-worker-12345678.js','/* finite media bridge */']]
 const assets=[]
 for(const [url,path,value]of values){await mkdir(dirname(join(root,path)),{recursive:true});await writeFile(join(root,path),value);assets.push({url,path,bytes:Buffer.byteLength(value),sha256:createHash('sha256').update(value).digest('hex')})}
 const manifest:UiReleaseManifest={schema:1,native:[{dshVersion:'0.2.0-rc.2',adapter:'rc2-native-1',revision,manifest:`ui/${revision}/ui-artifact-manifest.json`}],legacy:{revision:legacy,html:'legacy.html'},inlineScripts:[],inlineStyles:[],assets}
 const save=()=>writeFile(join(root,'ui-release.json'),JSON.stringify(manifest));await save()
 return{root,manifest,save,close:()=>rm(root,{recursive:true,force:true})}
}
test('only inventoried GET/HEAD URLs load, with nested query identity, MIME and immutable caching',async()=>{
 const f=await fixture(),server=createServer(async(req,res)=>{try{if(!await serveUiAsset(f.root,req,res))res.writeHead(404).end()}catch{res.writeHead(503).end()}})
 try{
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${(server.address() as any).port}`
  const path=f.manifest.assets[3].url
  const reply=await fetch(base+path);expect(reply.status).toBe(200);expect(await reply.text()).toBe('export const value=1')
  expect(reply.headers.get('service-worker-allowed')).toBeNull();expect((await fetch(base+'/assets/media-worker-12345678.js')).headers.get('service-worker-allowed')).toBe('/connect/');
  expect(reply.headers.get('content-type')).toContain('javascript');expect(reply.headers.get('cache-control')).toContain('immutable')
  const head=await fetch(base+path,{method:'HEAD'});expect(head.status).toBe(200);expect(await head.text()).toBe('');expect(head.headers.get('content-length')).toBe(reply.headers.get('content-length'))
  for(const bad of [path.replace('?rev=1','?rev=2'),'/ui/unlisted.js','/ui/%2e%2e/private','/assets/unlisted.js'])expect((await fetch(base+bad)).status).toBe(404)
  expect((await fetch(base+path,{method:'POST'})).status).toBe(404)
  const entry=await fetch(base+'/connect/11111111-1111-4111-8111-111111111111');expect(entry.status).toBe(200);expect(entry.headers.get('cache-control')).toBe('no-store')
  const csp=entry.headers.get('content-security-policy')!
  expect(csp).toContain("base-uri 'none'");expect(csp).not.toMatch(/unsafe-(?:inline|eval)/)
  expect(csp).toContain("worker-src 'self' blob:")
  expect(csp).toContain("style-src-attr 'unsafe-hashes'")
  expect(csp).toContain("'sha256-NGXJlUMtA6PfUJUWvyyl+0DAVkwsL54hJes9itrN+6E='")
  await writeFile(join(f.root,f.manifest.assets[3].path),'tampered')
  expect((await fetch(base+path)).status).toBe(503)
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await f.close()}
})
test('missing, changed, symlinked, escaping or duplicate release files fail before readiness',async()=>{
 for(const damage of ['missing','changed','symlink','traversal','duplicate','unsafe-csp'] as const){
  const f=await fixture()
  try{
   const item=f.manifest.assets[3],path=join(f.root,item.path)
   if(damage==='missing')await rm(path)
   if(damage==='changed')await writeFile(path,'changed')
   if(damage==='symlink'){await rm(path);await symlink(join(f.root,'index.html'),path)}
   if(damage==='traversal'){item.path='../outside';await f.save()}
   if(damage==='duplicate'){f.manifest.assets.push({...item});await f.save()}
   if(damage==='unsafe-csp'){f.manifest.inlineScripts.push("'unsafe-eval'");await f.save()}
   await expect(verifyUiRelease(f.root)).rejects.toThrow()
  }finally{await f.close()}
 }
})
test('a verified release publishes only its exact available native profile',async()=>{
 const f=await fixture()
 try{const result=await loadUiRelease(f.root);expect(result?.manifest.native).toEqual(f.manifest.native);await verifyUiRelease(f.root)}finally{await f.close()}
})
test('published combo URLs with a trailing plugin directory and double query delimiter remain exact',async()=>{
 const f=await fixture()
 try{
  f.manifest.assets[3].url=`/ui/${revision}/plugins/??@deepseek-ai/example/client.js&rev=1`;await f.save()
  expect((await loadUiRelease(f.root))?.assets.has(f.manifest.assets[3].url)).toBe(true)
 }finally{await f.close()}
})
test('real Relay serves the inventory without its old wildcard fallback, and readiness includes nested chunks',async()=>{
 const f=await fixture();let relay:Awaited<ReturnType<typeof startRelay>>|undefined
 try{
  await writeFile(join(f.root,'assets/unlisted.js'),'must not be served')
  relay=await startRelay({publicOrigin:'https://relay.test',listenHost:'127.0.0.1',port:0,databasePath:join(f.root,'private.sqlite'),enrollmentVerifier:hashSecret('S'.repeat(43)),staticDir:f.root,heartbeatMs:1000,leaseTtlMs:5000,limits:DEFAULT_LIMITS})
  const base=`http://127.0.0.1:${relay.port}`
  expect((await fetch(base+'/health/ready')).status).toBe(200)
  expect((await fetch(base+'/assets/unlisted.js')).status).toBe(404)
  expect((await fetch(base+f.manifest.assets[3].url,{method:'HEAD'})).status).toBe(200)
  const legacyPage=await fetch(base+`/connect/11111111-1111-4111-8111-111111111111?legacy=${legacy}`)
  expect(await legacyPage.text()).toBe('<html>legacy</html>');expect(legacyPage.headers.get('content-security-policy')).toContain("frame-ancestors 'self'")
  await rm(join(f.root,f.manifest.assets[3].path))
  expect((await fetch(base+'/health/ready')).status).toBe(503);expect((await fetch(base+'/health/live')).status).toBe(200)
 }finally{await relay?.close();await f.close()}
})
test('losing a native manifest cannot re-enable legacy wildcard serving',async()=>{
 const f=await fixture();let relay:Awaited<ReturnType<typeof startRelay>>|undefined
 try{
  const html='<meta name="dsh-ui-release" content="1">';await writeFile(join(f.root,'index.html'),html)
  Object.assign(f.manifest.assets[0],{bytes:Buffer.byteLength(html),sha256:createHash('sha256').update(html).digest('hex')});await f.save()
  await writeFile(join(f.root,'assets/unlisted.js'),'must remain private to the build')
  relay=await startRelay({publicOrigin:'https://relay.test',listenHost:'127.0.0.1',port:0,databasePath:join(f.root,'db'),enrollmentVerifier:hashSecret('S'.repeat(43)),staticDir:f.root,heartbeatMs:1000,leaseTtlMs:5000,limits:DEFAULT_LIMITS})
  await rm(join(f.root,'ui-release.json'))
  const result=await fetch(`http://127.0.0.1:${relay.port}/assets/unlisted.js`)
  expect(result.status).not.toBe(200);expect(await result.text()).not.toContain('must remain private')
 }finally{await relay?.close();await f.close()}
})
