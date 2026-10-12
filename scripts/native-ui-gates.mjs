import {readFile,writeFile,realpath} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {join,resolve,dirname,relative} from 'node:path'
import {verifyCandidate,nativeResourceFingerprint,digestRows} from './native-ui-candidate.mjs'
import {verifyUiArtifacts,validateArtifactPaths} from './native-ui-artifacts.mjs'
const root=resolve(import.meta.dirname,'..'),sha=b=>createHash('sha256').update(b).digest('hex'),json=async path=>JSON.parse(await readFile(path,'utf8'))
const requiredSmoke=['candidate-ready-through-tls-nginx','public-release-manifest-hash','unlisted-resource-rejected','strict-csp-through-nginx','old-host-selects-frozen-legacy','upgrade-remove-applied','upgrade-install-applied','upgrade-instance-preserved','upgrade-link-preserved','upgrade-task-preserved','upgrade-renderer-preserved','native-entry-direct-mount','frozen-browser-new-host-compatible','rollback-remove-applied','rollback-install-applied','rollback-instance-preserved','rollback-link-preserved','rollback-task-preserved','rollback-renderer-preserved','rollback-legacy-ui-restored','page-errors-empty','product-csp-empty']
export const nativeGateCounts={core:21,parity:36}
export function validateNativeGateRuns(stage,runs){
 if(!Array.isArray(runs)||runs.length!==nativeGateCounts[stage])throw new Error('Incomplete '+stage)
 for(const run of runs){
  for(const violation of run.expectedSecurityCsp??[]){
   if(run.test!=='native current documents use original renderers and preserve downloaded bytes'||violation.directive!=='img-src'||violation.blocked!=='https://example.invalid/private.png'||violation.source!==''||violation.line!==0||violation.sample!=='')throw new Error('Unexpected security CSP exception')
  }
 }
 const keys=runs.map(r=>r.browser+':'+r.test)
 if(new Set(keys).size!==keys.length)throw new Error('Duplicate native gate case')
 const required=stage==='core'?['native slow media initialization keeps the selected session synchronized','native current-file scope confines the actual public Host filesystem','native current documents use original renderers and preserve downloaded bytes','native file reload, deletion, cancellation and takeover preserve a running task'].map(title=>'chromium:'+title):['chromium','webkit'].flatMap(browser=>[360,390,1280].map(width=>`${browser}:original current-file preview and download at ${width} CSS pixels`))
 if(required.some(key=>!keys.includes(key)))throw new Error('Missing current-file gate case')
}
export async function reviewCodeDigest(){
 const paths=execFileSync('git',['ls-files','--cached','--others','--exclude-standard'],{cwd:root,encoding:'utf8'}).trim().split('\n').filter(p=>/^(packages|scripts|tests)\/.*\.(ts|tsx|mjs|mts|py|css|sql|json|ya?ml)$/.test(p)||/^(Dockerfile|\.dockerignore|package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|tsconfig\.json)$/.test(p)||/^docs\/superpowers\/.*\.md$/.test(p))
 const rows=[];for(const path of[...new Set(paths)].sort()){try{rows.push({path,sha256:sha(await readFile(join(root,path)))})}catch(error){if(error.code!=='ENOENT')throw error}}
 return digestRows(rows)
}
async function reference(base,ref){
 if(!ref||Object.keys(ref).sort().join(',')!=='path,sha256'||typeof ref.path!=='string'||!/^[a-f0-9]{64}$/.test(ref.sha256))throw new Error('Missing evidence reference')
 const path=await realpath(resolve(base,ref.path));if(!path.startsWith(root+'/'))throw new Error('Evidence must belong to this worktree')
 const bytes=await readFile(path);if(sha(bytes)!==ref.sha256)throw new Error('Evidence hash mismatch');return{path,value:JSON.parse(bytes)}
}
export async function verifyRelease(manifestPath){
 const release=await json(manifestPath),base=dirname(resolve(manifestPath))
 if(release.schema!==1||release.kind!=='native-ui-release'||!/^[a-f0-9]{40}$/.test(release.sourceCommit??'')||!release.checks||Object.keys(release.checks).sort().join(',')!=='core,parity,review,smoke')throw new Error('Invalid release gates')
 const reports={};for(const name of['core','parity','smoke','review'])reports[name]=await reference(base,release.checks[name])
 for(const report of Object.values(reports))if(report.value.status!=='PASS')throw new Error('Gate is not PASS')
 const ref=await reference(base,release.candidate),{manifest:c,directory}=await verifyCandidate(ref.path)
 const review=reports.review.value
 if(review.kind!=='native-ui-review'||!/^[a-f0-9]{40}$/.test(review.reviewedCommit??'')||review.criticalUnresolved!==0||review.importantUnresolved!==0||review.codeDigest!==await reviewCodeDigest()||!Array.isArray(review.deferredMinors)||!Array.isArray(review.fixes))throw new Error('Missing, stale or unresolved independent review')
 execFileSync('git',['merge-base','--is-ancestor',review.reviewedCommit,release.sourceCommit],{cwd:root,stdio:'ignore'})
 const prefix=join(directory,'web/ui',c.ui.revision),stock=await json(join(prefix,'upstream-manifest.json'))
 const fingerprint=nativeResourceFingerprint(stock,await json(join(prefix,'startup-manifest.json')),await json(join(prefix,'graph.json')),await json(join(prefix,'boot-injections.json')))
 for(const stage of ['core','parity']){
  const report=reports[stage].value;validateNativeGateRuns(stage,report.runs)
  for(const r of report.runs){
   if(r.status!=='PASS'||r.releaseGate!=='PASS'||r.csp.length||r.browserErrors.length||r.cleanup.sockets||!r.cleanup.hostExited||r.cleanupErrors.length||r.processes.some(p=>!p.ended)||r.pluginSha256!==c.plugin.sha256)throw new Error('Invalid '+stage+' run')
   const source=Object.entries(r.sourceSha256);if(source.length<20||['packages/web/src/native-ui/file-media.ts','packages/web/src/native-ui/media-worker.ts','packages/web/src/native-ui/media-response.ts','packages/web/src/native-ui/media-install.ts','packages/web/src/native-ui/files.ts','packages/web/src/native-ui/file-routes.ts','tests/e2e/native-current-documents.ts'].some(path=>!r.sourceSha256[path]))throw new Error('Incomplete gate source inventory');validateArtifactPaths(source.map(([path])=>path))
   for(const[path,hash]of source)if(sha(await readFile(join(root,path)))!==hash)throw new Error('Stale gate source: '+path)
   const runDir=await realpath(r.directory);if(!runDir.startsWith(join(root,'data/native-ui/')))throw new Error('Not an owned native run')
   const artifacts=await json(join(runDir,'artifacts/manifest.json'));await verifyUiArtifacts(join(runDir,'artifacts'),artifacts)
   const startup=await json(join(runDir,'startup/manifest.json'));validateArtifactPaths(startup.assets.map(a=>a.path));for(const a of startup.assets)if(sha(await readFile(join(runDir,'startup',a.path)))!==a.sha256)throw new Error('Startup bytes changed')
   if(nativeResourceFingerprint(artifacts,startup,await json(join(runDir,'artifacts/graph.json')),await json(join(runDir,'artifacts/boot-injections.json')))!==fingerprint)throw new Error('Native resource drift')
  }
 }
 const smoke=reports.smoke.value,ui=await json(join(directory,'web/ui-release.json'))
 if(smoke.candidateManifestSha256!==sha(await readFile(ref.path)))throw new Error('Smoke candidate mismatch')
 if(smoke.sourceDigest!==c.sourceDigest||smoke.artifactDigest!==c.artifactDigest||smoke.image.id!==c.image.id||smoke.uiRevision!==c.ui.revision||!smoke.containerCleanup||!smoke.hostExited||smoke.pageErrors.length||smoke.csp.length||smoke.processes.some(p=>!p.ended)||smoke.checks.some(x=>x.ok!==true))throw new Error('Invalid image/lifecycle smoke')
 const names=smoke.checks.map(x=>x.name),expected=[...requiredSmoke,...ui.assets.flatMap(a=>['resource:'+a.url,'head:'+a.url])]
 if(names.length!==expected.length||new Set(names).size!==names.length||expected.some(name=>!names.includes(name)))throw new Error('Incomplete image smoke')
 if(smoke.runnerSha256!==sha(await readFile(join(root,'scripts/native-ui-smoke.mjs'))))throw new Error('Stale smoke runner')
 return{release,candidate:c,candidateDirectory:directory,manifestPath:resolve(manifestPath),releaseHash:sha(await readFile(manifestPath))}
}
export async function sealRelease({candidateManifestPath,smokePath,reviewPath,outputPath}){
 const base=dirname(resolve(outputPath)),ref=async path=>({path:relative(base,resolve(path)),sha256:sha(await readFile(path))})
 const release={schema:1,kind:'native-ui-release',sourceCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),candidate:await ref(candidateManifestPath),checks:{core:await ref(join(root,'docs/native-ui-core-result.json')),parity:await ref(join(root,'docs/native-ui-parity-result.json')),smoke:await ref(smokePath),review:await ref(reviewPath)}}
 await writeFile(outputPath,JSON.stringify(release,null,2),{flag:'wx'});return verifyRelease(outputPath)
}
