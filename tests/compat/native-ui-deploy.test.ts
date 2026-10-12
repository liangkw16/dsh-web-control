import {test,expect,vi} from 'vitest'
import {mkdtemp,writeFile,readFile,rm,cp} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve,relative} from 'node:path'
import {createHash} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {deployRelease,rollbackRelease,verifyRelease,reviewCodeDigest} from '../../scripts/native-ui-release.mjs'
import {archiveIdentity} from '../../scripts/native-ui-deploy.mjs'
test.each([{}, {schema:1,checks:[]}, {schema:1,kind:'native-ui-release',checks:{core:{status:'PASS'},parity:{status:'NOT_RUN'},smoke:{status:'PASS'}}}])('incomplete gates cannot start a server command: %j',async manifest=>{
 const dir=await mkdtemp(join(tmpdir(),'native-deploy-')),run=vi.fn()
 try{const manifestPath=join(dir,'release.json');await writeFile(manifestPath,JSON.stringify(manifest));await expect(deployRelease({manifestPath,server:'relay-host',run})).rejects.toThrow();expect(run).not.toHaveBeenCalled()}finally{await rm(dir,{recursive:true,force:true})}
})
const sha=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex')
async function releaseFixture(copyCandidate=false){
 const dir=await mkdtemp(resolve('data/native-ui-release-unit-'))
 const source=resolve(process.env.WEB_CONTROL_CANDIDATE_DIR??'data/native-ui-candidate-compat6-v3'),candidate=copyCandidate?join(dir,'candidate'):source
 if(copyCandidate)await cp(source,candidate,{recursive:true})
 const ref=async(path:string)=>({path:relative(dir,resolve(path)),sha256:sha(await readFile(path))})
 const commit=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),reviewPath=join(dir,'review.json')
 await writeFile(reviewPath,JSON.stringify({kind:'native-ui-review',status:'PASS',reviewedCommit:commit,codeDigest:await reviewCodeDigest(),criticalUnresolved:0,importantUnresolved:0,deferredMinors:[],fixes:[],note:'TEST FIXTURE ONLY; no actual review or production action'}))
 const manifest:any={schema:1,kind:'native-ui-release',sourceCommit:commit,candidate:await ref(join(candidate,'manifest.json')),checks:{core:await ref('docs/native-ui-core-result.json'),parity:await ref('docs/native-ui-parity-result.json'),smoke:await ref('docs/native-ui-smoke-result.json'),review:await ref(reviewPath)}}
 const manifestPath=join(dir,'release.json'),save=()=>writeFile(manifestPath,JSON.stringify(manifest))
 await save();return{dir,candidate,manifest,manifestPath,save,ref,close:()=>rm(dir,{recursive:true,force:true})}
}
test.each(['core','parity','smoke','review'])('a missing %s receipt rejects before SSH',async name=>{
 const f=await releaseFixture(),run=vi.fn()
 try{delete f.manifest.checks[name];await f.save();await expect(deployRelease({manifestPath:f.manifestPath,server:'relay-host',run})).rejects.toThrow();expect(run).not.toHaveBeenCalled()}finally{await f.close()}
})
test.each(['not-run','receipt-hash','source-hash','resource-hash','rollback-missing'])('release refuses %s before server commands',async damage=>{
 const f=await releaseFixture(['resource-hash','rollback-missing','source-hash'].includes(damage)),run=vi.fn()
 try{
  if(damage==='not-run'){const path=join(f.dir,'not-run.json');await writeFile(path,JSON.stringify({status:'NOT_RUN'}));f.manifest.checks.smoke=await f.ref(path)}
  if(damage==='receipt-hash')f.manifest.checks.core.sha256='0'.repeat(64)
  if(damage==='source-hash'){const path=join(f.candidate,'manifest.json'),candidate=JSON.parse(await readFile(path,'utf8'));candidate.source[0].sha256='0'.repeat(64);await writeFile(path,JSON.stringify(candidate));f.manifest.candidate=await f.ref(path)}
  if(damage==='resource-hash')await writeFile(join(f.candidate,'web/legacy.html'),'corrupted')
  if(damage==='rollback-missing')await rm(join(f.candidate,'rollback/dsh-web-control-0.0.0-compat.5.tgz'))
  await f.save();await expect(deployRelease({manifestPath:f.manifestPath,server:'relay-host',run})).rejects.toThrow();expect(run).not.toHaveBeenCalled()
 }finally{await f.close()}
},45000)
test('archive identity binds the exported linux/amd64 config, not the local OCI index ID',()=>{
 const config=JSON.stringify({os:'linux',architecture:'amd64',config:{Labels:{'io.dsh.source':'a'.repeat(64)}}}),manifest=[{Config:'blobs/sha256/'+sha(config)}],candidate={image:{platform:'linux/amd64'},sourceDigest:'a'.repeat(64)}
 expect(archiveIdentity(manifest,config,candidate)).toBe('sha256:'+sha(config))
 expect(()=>archiveIdentity(manifest,config+' ',candidate)).toThrow()
 expect(()=>archiveIdentity(manifest,config,{...candidate,sourceDigest:'b'.repeat(64)})).toThrow()
 expect(()=>archiveIdentity([{Config:'../../etc/passwd'}],config,candidate)).toThrow()
})
test('rollback requires explicit hash before any SSH',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'native-rollback-')),path=join(dir,'rollback.json'),run=vi.fn()
 try{await writeFile(path,'{}');await expect(rollbackRelease({manifestPath:path,manifestSha256:'0'.repeat(64),server:'relay-host',run})).rejects.toThrow();expect(run).not.toHaveBeenCalled()}finally{await rm(dir,{recursive:true,force:true})}
})
test('remote configuration activation and failure recovery use isolated files only',()=>{
 expect(()=>execFileSync('python3',['tests/compat/native-ui-remote.test.py'],{encoding:'utf8'})).not.toThrow()
})
test('verify is read-only and a failed online backup cannot invoke compose update',async()=>{
 const f=await releaseFixture(),run=vi.fn(async(argv:string[])=>({code:argv.some(a=>a.includes('backup'))?1:0,stdout:'fixture backup failure'}))
 try{
  const before=await readFile(f.manifestPath);await verifyRelease(f.manifestPath);expect(await readFile(f.manifestPath)).toEqual(before)
  await expect(deployRelease({manifestPath:f.manifestPath,server:'relay-host',run})).rejects.toThrow(/backup/i)
  expect(run.mock.calls.some(([argv])=>argv.some(a=>a.includes('backup')))).toBe(true)
  expect(run.mock.calls.some(([argv])=>argv.some(a=>a.includes('compose')&&a.includes('up')))).toBe(false)
 }finally{await f.close()}
},45000)
