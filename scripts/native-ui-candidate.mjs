import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {cp,lstat,mkdir,readFile,readdir,writeFile} from 'node:fs/promises'
import {dirname,join,resolve} from 'node:path'
import {assembleUiRelease,frozenLegacy} from './native-ui-resources.mjs'
import {validateArtifactPaths,verifyUiArtifacts} from './native-ui-artifacts.mjs'
const root=resolve(import.meta.dirname,'..'),sha=bytes=>createHash('sha256').update(bytes).digest('hex')
export const digestRows=rows=>sha(rows.map(({path,sha256})=>path+'\0'+sha256).join('\n'))
/** Compare verified inventories. rc.2's top graph rev includes the isolated profile;
 * resource URLs, module revisions, facade scripts and every business byte stay bound. */
export function nativeResourceFingerprint(artifacts,startup,graph,injections){
 const normalizeGraph=value=>({...value,rev:'profile-owned-boot-revision'})
 const metadata=new Map([[artifacts.graphPath,JSON.stringify(normalizeGraph(graph))],['boot-injections.json',JSON.stringify(injections.map(row=>row.kind==='global'&&row.name==='__DSH_BOOT__'?{...row,value:normalizeGraph(row.value)}:row))]])
 const canonical={...artifacts,revision:'profile-owned-boot-revision',assets:artifacts.assets.map(row=>metadata.has(row.path)?{...row,sha256:sha(metadata.get(row.path)),bytes:Buffer.byteLength(metadata.get(row.path))}:row)}
 return sha(JSON.stringify({artifacts:canonical,startup}))
}
async function regular(directory,path){validateArtifactPaths([path]);let file=directory;for(const part of path.split('/')){file=join(file,part);if((await lstat(file)).isSymbolicLink())throw new Error('Symbolic candidate path')}if(!(await lstat(file)).isFile())throw new Error('Candidate file required');return readFile(file)}
async function files(directory,prefix=''){const out=[];for(const e of(await readdir(join(directory,prefix),{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const p=prefix+e.name;if(e.isSymbolicLink())throw new Error('Symbolic candidate path');if(e.isDirectory())out.push(...await files(directory,p+'/'));else if(e.isFile())out.push(p)}return out}
export async function sourceInventory(){
 const paths=execFileSync('git',['ls-files','--cached','--others','--exclude-standard'],{cwd:root,encoding:'utf8'}).trim().split('\n').filter(p=>/^(Dockerfile|\.dockerignore|package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|tsconfig\.json)$/.test(p)||/^packages\/(plugin|relay|web|protocol)\/(src\/.*\.(ts|tsx|css|sql)|package\.json|tsdown\.config\.ts|vite\.config\.ts|build\.mjs|index\.html|cordis\.patch\.yml)$/.test(p)||/^scripts\/native-ui-(resources|artifacts|startup)\.mjs$/.test(p))
 const rows=[];for(const path of [...new Set(paths)].sort()){try{rows.push({path,sha256:sha(await regular(root,path))})}catch(error){if(error.code!=='ENOENT')throw error}}
 return rows
}
export async function verifyCandidate(manifestPath,{sourceRoot=root}={}){
 const directory=dirname(resolve(manifestPath)),m=JSON.parse(await readFile(manifestPath,'utf8'))
 if(m.schema!==1||m.kind!=='native-ui-candidate'||!Array.isArray(m.source)||!m.source.length||!Array.isArray(m.files)||!m.files.length||!/^sha256:[a-f0-9]{64}$/.test(m.image?.id??'')||!['linux/amd64','linux/arm64'].includes(m.image?.platform)||!/^0\.0\.0-compat\.\d+$/.test(m.plugin?.version??'')||!m.ui||!m.rollback)throw new Error('Invalid candidate manifest')
 for(const[base,rows]of [[sourceRoot,m.source],[directory,m.files]]){validateArtifactPaths(rows.map(row=>row.path));for(const row of rows){if(!/^[a-f0-9]{64}$/.test(row.sha256)||sha(await regular(base,row.path))!==row.sha256)throw new Error('Candidate hash mismatch: '+row.path)}}
 if(digestRows(m.source)!==m.sourceDigest||digestRows(m.files)!==m.artifactDigest)throw new Error('Candidate digest mismatch')
 const known=(path,hash)=>m.files.some(row=>row.path===path&&row.sha256===hash)
 if(!known(m.plugin.path,m.plugin.sha256)||!known(m.ui.path,m.ui.sha256)||!known(m.rollback.pluginPath,frozenLegacy.plugin)||m.rollback.legacyManifestSha256!==frozenLegacy.manifest)throw new Error('Candidate release/rollback binding missing')
 const ui=JSON.parse(await regular(directory,m.ui.path));if(ui.native.length!==1||ui.native[0].revision!==m.ui.revision||ui.legacy.revision!==frozenLegacy.manifest)throw new Error('Candidate UI binding mismatch')
 const{verifyUiRelease}=await import('../packages/relay/dist/ui-assets.js');await verifyUiRelease(join(directory,'web'))
 return{manifest:m,directory}
}
export async function buildCandidate({outputDir,artifactsDir,startupDir,legacyDir,platform='linux/amd64'}){
 if(!['linux/amd64','linux/arm64'].includes(platform))throw new Error('Explicit supported image platform required')
 for(const path of[outputDir,artifactsDir,startupDir,legacyDir])if(typeof path!=='string'||!path)throw new Error('Explicit candidate inputs required')
 const directory=resolve(outputDir),inputs=[artifactsDir,startupDir,legacyDir].map(p=>resolve(p))
 if(inputs.some(p=>p===directory||p.startsWith(directory+'/')))throw new Error('Output overlaps candidate inputs')
 if(sha(await regular(resolve(legacyDir),'manifest.json'))!==frozenLegacy.manifest||sha(await regular(resolve(legacyDir),'dsh-web-control-0.0.0-compat.5.tgz'))!==frozenLegacy.plugin)throw new Error('Frozen rollback verification failed')
 await verifyUiArtifacts(resolve(artifactsDir),JSON.parse(await regular(resolve(artifactsDir),'manifest.json')))
 await mkdir(directory)
 const pnpm=process.env.WEB_CONTROL_PNPM_CLI,runPnpm=args=>execFileSync(pnpm?process.execPath:'pnpm',pnpm?[pnpm,...args]:args,{cwd:root,stdio:'inherit'})
 runPnpm(['build']);runPnpm(['--filter','dsh-web-control','pack','--pack-destination',directory])
 const plugin=JSON.parse(await readFile(join(root,'packages/plugin/package.json'),'utf8'))
 await mkdir(join(directory,'plugin'));await cp(join(root,'packages/plugin/dist'),join(directory,'plugin/dist'),{recursive:true});await cp(join(root,'packages/plugin/package.json'),join(directory,'plugin/package.json'))
 const pluginPath=`dsh-web-control-${plugin.version}.tgz`;execFileSync(process.execPath,[join(root,'scripts/check-package.mjs'),directory],{cwd:root,stdio:'inherit'})
 await mkdir(join(directory,'rollback'));await cp(join(legacyDir,'dsh-web-control-0.0.0-compat.5.tgz'),join(directory,'rollback/dsh-web-control-0.0.0-compat.5.tgz'))
 const ui=await assembleUiRelease({artifactsDir:resolve(artifactsDir),startupDir:resolve(startupDir),legacyDir:resolve(legacyDir),webDir:join(root,'packages/web/dist'),outputDir:join(directory,'web')})
 const source=await sourceInventory(),sourceDigest=digestRows(source),context=join(directory,'context');await mkdir(context)
 for(const item of source){await mkdir(dirname(join(context,item.path)),{recursive:true});await cp(join(root,item.path),join(context,item.path))}
 await mkdir(join(context,'release-input'));await cp(join(directory,'web'),join(context,'release-input/web'),{recursive:true})
 const tag='dsh-web-control-native:'+sourceDigest.slice(0,16)
 execFileSync('docker',['build','--platform',platform,'--label','io.dsh.source='+sourceDigest,'-t',tag,context],{cwd:root,stdio:'inherit'})
 const image=JSON.parse(execFileSync('docker',['image','inspect',tag],{encoding:'utf8'}))[0]
 if(image.Os+'/'+image.Architecture!==platform)throw new Error('Candidate platform mismatch')
 const inventory=await Promise.all((await files(directory)).map(async path=>({path,sha256:sha(await regular(directory,path))})))
 const manifest={schema:1,kind:'native-ui-candidate',status:'CANDIDATE',createdAt:new Date().toISOString(),sourceCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),source,sourceDigest,files:inventory,artifactDigest:digestRows(inventory),image:{id:image.Id,platform},plugin:{version:plugin.version,path:pluginPath,sha256:sha(await regular(directory,pluginPath))},ui:{revision:ui.native[0].revision,path:'web/ui-release.json',sha256:sha(await regular(directory,'web/ui-release.json'))},rollback:{pluginPath:'rollback/dsh-web-control-0.0.0-compat.5.tgz',legacyManifestSha256:frozenLegacy.manifest},protocol:1,schemaVersion:1}
 await writeFile(join(directory,'manifest.json'),JSON.stringify(manifest,null,2),{flag:'wx'});await verifyCandidate(join(directory,'manifest.json'))
 return{directory,image:manifest.image,uiRevision:manifest.ui.revision,pluginSha256:manifest.plugin.sha256,sourceDigest}
}
