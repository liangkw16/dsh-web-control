import {lstat,readFile,realpath} from 'node:fs/promises'
import {join,resolve,extname} from 'node:path'
import {createHash} from 'node:crypto'
import type {IncomingMessage,ServerResponse} from 'node:http'
import {ProtocolError} from '@dsh-web-control/protocol'
export interface UiAsset {url:string;path:string;bytes:number;sha256:string}
export interface UiReleaseManifest {
 schema:1
 native:{dshVersion:'0.2.0-rc.2';adapter:'rc2-native-1';revision:string;manifest:string}[]
 legacy:{revision:string;html:string}
 inlineScripts:string[];inlineStyles:string[];assets:UiAsset[]
}
interface Release {root:string;manifest:UiReleaseManifest;bytes:Buffer;assets:Map<string,UiAsset>}
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex'),digest=/^[a-f0-9]{64}$/
const invalid=():never=>{throw new ProtocolError('STORAGE_ERROR')}
async function absentRelease(root:string):Promise<undefined>{
 try{
  const entry=join(root,'index.html'),info=await lstat(entry)
  if(info.isSymbolicLink()||!info.isFile()||info.size>1024*1024)return invalid()
  if(/name=["']dsh-ui-release["']/.test(await readFile(entry,'utf8')))return invalid()
 }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
 return undefined
}
function pathParts(path:unknown):string[]{
 if(typeof path!=='string'||!path||path.length>8192||/[\\%?#:\x00-\x20\x7f]/.test(path))return invalid()
 const parts=path.split('/');if(parts.some(v=>!v||v==='.'||v==='..'))return invalid();return parts
}
function assetUrl(url:unknown):string {
 if(typeof url!=='string'||!url.startsWith('/')||url.startsWith('//')||/[\\%#\x00-\x20\x7f]/.test(url)||url.length>8192)return invalid()
 pathParts(url.slice(1).split('?')[0].replace(/\/$/,''));if(new URL(url,'https://assets.invalid').origin!=='https://assets.invalid')return invalid();return url
}
async function regular(root:string,path:string):Promise<string>{
 let file=root;const parts=pathParts(path)
 for(const [i,part]of parts.entries()){
  file=join(file,part);const info=await lstat(file)
  if(info.isSymbolicLink()||(i===parts.length-1?!info.isFile():!info.isDirectory()))return invalid()
 }
 return file
}
async function assetBytes(release:Pick<Release,'root'>,asset:UiAsset):Promise<Buffer>{
 const path=await regular(release.root,asset.path),info=await lstat(path)
 if(info.size!==asset.bytes)return invalid()
 const bytes=await readFile(path);if(bytes.length!==asset.bytes||hash(bytes)!==asset.sha256)return invalid();return bytes
}
/** Validates every release file, including resources absent from the entry HTML. */
export async function loadUiRelease(directory:string):Promise<Release|undefined>{
 try{
  if((await lstat(directory)).isSymbolicLink())return invalid()
  const root=await realpath(directory),manifestPath=join(root,'ui-release.json')
  let info;try{info=await lstat(manifestPath)}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return absentRelease(root);throw error}
  if(!info.isFile()||info.isSymbolicLink()||info.size>1024*1024)return invalid()
  const bytes=await readFile(manifestPath),manifest=JSON.parse(bytes.toString()) as UiReleaseManifest
  if(!manifest||manifest.schema!==1||Object.keys(manifest).sort().join(',')!=='assets,inlineScripts,inlineStyles,legacy,native,schema'||!Array.isArray(manifest.assets)||!manifest.assets.length||manifest.assets.length>2048||!Array.isArray(manifest.native)||manifest.native.length>8)return invalid()
  for(const hashes of [manifest.inlineScripts,manifest.inlineStyles])if(!Array.isArray(hashes)||hashes.length>512||hashes.some(v=>typeof v!=='string'||!/^sha256-[A-Za-z0-9+/]{43}=$/.test(v)))return invalid()
  const assets=new Map<string,UiAsset>(),paths=new Set<string>()
  for(const item of manifest.assets){
   if(!item||Object.keys(item).sort().join(',')!=='bytes,path,sha256,url'||!digest.test(item.sha256)||!Number.isSafeInteger(item.bytes)||item.bytes<0||item.bytes>128*1024*1024)return invalid()
   pathParts(item.path);assetUrl(item.url)
   if(paths.has(item.path)||assets.has(item.url))return invalid();paths.add(item.path);assets.set(item.url,item)
  }
  if(!assets.has('/index.html')||assets.get('/index.html')!.bytes===0||!manifest.legacy||Object.keys(manifest.legacy).sort().join(',')!=='html,revision'||!digest.test(manifest.legacy.revision)||!paths.has(manifest.legacy.html))return invalid()
  const versions=new Set<string>()
  for(const ui of manifest.native){
   if(Object.keys(ui).sort().join(',')!=='adapter,dshVersion,manifest,revision'||ui.dshVersion!=='0.2.0-rc.2'||ui.adapter!=='rc2-native-1'||!digest.test(ui.revision)||ui.manifest!==`ui/${ui.revision}/ui-artifact-manifest.json`||!paths.has(ui.manifest)||versions.has(ui.dshVersion))return invalid()
   versions.add(ui.dshVersion)
  }
  const release={root,manifest,bytes,assets}
  for(const asset of assets.values())await assetBytes(release,asset)
  return release
 }catch(error){if(error instanceof ProtocolError)throw error;return invalid()}
}
export async function verifyUiRelease(root:string):Promise<void>{if(!await loadUiRelease(root))invalid()}
const cached=new Map<string,{stamp:string;release:Release|undefined}>()
async function servingRelease(directory:string):Promise<Release|undefined>{
 const key=resolve(directory);let info
 try{info=await lstat(join(key,'ui-release.json'))}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return absentRelease(key);return invalid()}
 if(info.isSymbolicLink()||!info.isFile())return invalid()
 const stamp=`${info.mtimeMs}:${info.ctimeMs}:${info.size}`,old=cached.get(key)
 if(old?.stamp===stamp)return old.release
 const release=await loadUiRelease(key);cached.set(key,{stamp,release});if(cached.size>32)cached.delete(cached.keys().next().value!)
 return release
}
// rc.2's stock Shiki CSS-variable theme emits these finite token styles. Permit
// their hashes only; arbitrary file-supplied style attributes remain blocked.
const tokenColors=['foreground','token-link','token-string','token-comment','token-constant','token-keyword','token-parameter','token-function','token-string-expression','token-punctuation','token-inserted','token-deleted','token-changed']
const documentStyles=['background-color:var(--shiki-background);color:var(--shiki-foreground)']
for(const color of tokenColors)for(let bits=0;bits<8;bits++)documentStyles.push(`color:var(--shiki-${color})${bits&1?';font-style:italic':''}${bits&2?';font-weight:bold':''}${bits&4?';text-decoration:underline':''}`)
const documentStyleHashes=documentStyles.map(style=>`'sha256-${createHash('sha256').update(style).digest('base64')}'`).join(' ')
function policy(release:Release,legacy:boolean):string{
 const documents=legacy?'':` style-src-attr 'unsafe-hashes' ${documentStyleHashes}; worker-src 'self' blob:;`
 return `default-src 'self'; script-src 'self' ${release.manifest.inlineScripts.map(h=>`'${h}'`).join(' ')}; style-src 'self' ${release.manifest.inlineStyles.map(h=>`'${h}'`).join(' ')};${documents} font-src 'self' data:; connect-src 'self'; img-src 'self' data: blob:; frame-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors ${legacy?"'self'":"'none'"}`
}
/** Exact URL inventory only; query-addressed plugin chunks are not directory routes. */
export async function serveUiAsset(directory:string,request:IncomingMessage,response:ServerResponse):Promise<boolean|undefined>{
 if(!['GET','HEAD'].includes(request.method??''))return false
 const release=await servingRelease(directory);if(!release)return
 const url=request.url??'';try{if(url!=='/')assetUrl(url)}catch{return false}
 const connect=/^\/connect\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/?$/.test(url.split('?')[0])
 const legacy=connect&&url.split('?')[1]===`legacy=${release.manifest.legacy.revision}`
 const entry=url==='/'||connect&&!url.includes('?'),key=entry?'/index.html':url
 const item=legacy?release.manifest.assets.find(a=>a.path===release.manifest.legacy.html):release.assets.get(key)
 if(!item&&url!=='/ui-release.json')return false
 const bytes=item?await assetBytes(release,item):release.bytes
 const types:Record<string,string>={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp','.woff':'font/woff','.woff2':'font/woff2','.txt':'text/plain; charset=utf-8','.webmanifest':'application/manifest+json'}
 const extension=item?extname(item.path):'.json',immutable=item&&(item.url.startsWith('/ui/')||/^\/assets\/[^/]+[-.][A-Za-z0-9_-]{8,}\./.test(item.url))&&extension!=='.html'
 response.writeHead(200,{...(item&&/^\/assets\/media-worker-[A-Za-z0-9_-]+\.js$/.test(item.url)?{'Service-Worker-Allowed':'/connect/'}:{}),'Content-Type':types[extension]??'application/octet-stream','Content-Length':String(bytes.length),'Cache-Control':immutable?'public, max-age=31536000, immutable':'no-store','Content-Security-Policy':policy(release,legacy),'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'})
 response.end(request.method==='HEAD'?undefined:bytes);return true
}
