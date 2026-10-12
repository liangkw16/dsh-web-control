/** Native UI release assembly. Published business assets are copied, never rebuilt. */
import {createHash} from 'node:crypto'
import {lstat,mkdir,readFile,readdir,writeFile} from 'node:fs/promises'
import {dirname,join} from 'node:path'
import {verifyUiArtifacts,validateArtifactPaths} from './native-ui-artifacts.mjs'
import {inlineStyleHashes} from './native-ui-startup.mjs'
const sha=bytes=>createHash('sha256').update(bytes).digest('hex')
export const frozenLegacy={manifest:'85a2306082e74222d2adbd09cec44758b188c5bccc23e5430e6c10032ada70d6',plugin:'10efb2b55e7ca42ddaeb5dcb400fba0f2561e768f74136c34355531db77a3b40'}
async function file(root,path){
 validateArtifactPaths([path]);let target=root
 if((await lstat(root)).isSymbolicLink())throw new Error('Symbolic resource root')
 for(const[index,part]of path.split('/').entries()){target=join(target,part);const stat=await lstat(target);if(stat.isSymbolicLink()||(index===path.split('/').length-1?!stat.isFile():!stat.isDirectory()))throw new Error('Non-regular resource')}
 return readFile(target)
}
async function walk(root,prefix=''){
 const result=[]
 for(const entry of(await readdir(join(root,prefix),{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const path=prefix+entry.name;if(entry.isSymbolicLink())throw new Error('Symbolic build resource');if(entry.isDirectory())result.push(...await walk(root,path+'/'));else if(entry.isFile())result.push(path)}
 return result
}
export async function assembleUiRelease({artifactsDir,startupDir,webDir,legacyDir,outputDir}){
 const legacyManifest=await file(legacyDir,'manifest.json')
 if(sha(legacyManifest)!==frozenLegacy.manifest)throw new Error('Frozen legacy manifest mismatch')
 const legacy=JSON.parse(legacyManifest),legacyFiles=legacy.built.filter(row=>row.path.startsWith('web/'))
 if(!legacyFiles.length)throw new Error('Frozen legacy resources missing')
 const legacyBytes=new Map()
 for(const item of legacyFiles){const bytes=await file(legacyDir,item.path);if(sha(bytes)!==item.sha256)throw new Error('Frozen legacy bytes mismatch');legacyBytes.set(item.path.slice(4),bytes)}
 const artifactBytes=await file(artifactsDir,'manifest.json'),artifacts=JSON.parse(artifactBytes)
 await verifyUiArtifacts(artifactsDir,artifacts)
 const startupBytes=await file(startupDir,'manifest.json'),startup=JSON.parse(startupBytes)
 if(startup.schema!==1||startup.dshVersion!==artifacts.dshVersion||!Array.isArray(startup.assets))throw new Error('Invalid startup manifest')
 validateArtifactPaths(startup.assets.map(row=>row.path));if(!startup.assets.some(row=>row.path===startup.entry))throw new Error('Missing startup entry')
 for(const item of startup.assets){const bytes=await file(startupDir,item.path);if(bytes.length!==item.bytes||sha(bytes)!==item.sha256)throw new Error('Startup integrity failure')}
 const revision=sha(JSON.stringify({artifacts,startup})),prefix=`ui/${revision}/`
 await mkdir(outputDir) // Refuse to overwrite a prior candidate or its evidence.
 const release={schema:1,native:[{dshVersion:'0.2.0-rc.2',adapter:'rc2-native-1',revision,manifest:prefix+'ui-artifact-manifest.json'}],legacy:{revision:frozenLegacy.manifest,html:'legacy.html'},inlineScripts:[],inlineStyles:[],assets:[]}
 const styleHashes=new Set(),scriptHashes=new Set()
 const add=async(path,bytes,url='/'+path)=>{
  validateArtifactPaths([path]);if(release.assets.some(row=>row.path===path||row.url===url))throw new Error('Duplicate release resource')
  await mkdir(dirname(join(outputDir,path)),{recursive:true});await writeFile(join(outputDir,path),bytes,{flag:'wx'})
  release.assets.push({path,url,bytes:bytes.length,sha256:sha(bytes)})
  if(path.endsWith('.js'))for(const hash of inlineStyleHashes(bytes.toString()))styleHashes.add(hash.slice(1,-1))
 }
 for(const path of await walk(webDir))await add(path,await file(webDir,path))
 for(const[path,bytes]of legacyBytes)await add(path==='index.html'?'legacy.html':path==='browser-modules.json'?'legacy-browser-modules.json':path,bytes)
 for(const item of artifacts.assets)await add(prefix+item.path,await file(artifactsDir,item.path),'/' +prefix+(item.url??item.path))
 for(const item of startup.assets)await add(prefix+item.path,await file(startupDir,item.path))
 await add(prefix+'stock-shell.html',await file(artifactsDir,artifacts.entryHtml))
 await add(prefix+'upstream-manifest.json',artifactBytes);await add(prefix+'startup-manifest.json',startupBytes)
 await add(prefix+'ui-artifact-manifest.json',Buffer.from(JSON.stringify({...artifacts,startup,uiRevision:revision})))
 for(const row of JSON.parse(await file(artifactsDir,'boot-injections.json')))if(row.kind==='script')scriptHashes.add('sha256-'+createHash('sha256').update(row.text).digest('base64'))
 release.inlineScripts=[...scriptHashes].sort();release.inlineStyles=[...styleHashes].sort();release.assets.sort((a,b)=>a.url.localeCompare(b.url))
 await writeFile(join(outputDir,'ui-release.json'),JSON.stringify(release,null,2),{flag:'wx'})
 return release
}