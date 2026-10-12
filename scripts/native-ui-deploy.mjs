import {verifyRelease} from './native-ui-gates.mjs'
import {readFile,writeFile,mkdtemp,chmod} from 'node:fs/promises'
import {createReadStream} from 'node:fs'
import {createHash,randomBytes} from 'node:crypto'
import {resolve,join} from 'node:path'
import {execFile} from 'node:child_process'
const root=resolve(import.meta.dirname,'..'),helper=join(root,'scripts/native-ui-remote.py')
const oldImage='sha256:0cf82dfe1d47125bcf0f8de0a592ac2edc94893b5d30a73acd888ea8b3bbaae6'
const sha=b=>createHash('sha256').update(b).digest('hex')
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'"
const ssh=(server,args)=>['ssh','-o','BatchMode=yes',server,args.map(quote).join(' ')]
export const runCommand=argv=>new Promise(resolve=>execFile(argv[0],argv.slice(1),{cwd:root,maxBuffer:4*1024*1024},(error,stdout)=>resolve({code:error?1:0,stdout})))
async function checked(run,argv,step){const r=await run(argv);if(r.code!==0)throw new Error(step+' failed; activation refused (inspect the owned release directory before retrying)');return r.stdout}
async function hashFile(path){const h=createHash('sha256');for await(const b of createReadStream(path))h.update(b);return h.digest('hex')}
export function archiveIdentity(manifest,configBytes,candidate){
 if(!Array.isArray(manifest)||manifest.length!==1||!/^blobs\/sha256\/[a-f0-9]{64}$|^[a-f0-9]{64}\.json$/.test(manifest[0]?.Config??''))throw new Error('Invalid image archive manifest')
 const config=JSON.parse(configBytes),hash=sha(configBytes),pathHash=manifest[0].Config.replace(/^blobs\/sha256\//,'').replace(/\.json$/,'')
 if(pathHash!==hash||config.os!=='linux'||config.architecture!=='amd64'||candidate.image.platform!=='linux/amd64'||config.config?.Labels?.['io.dsh.source']!==candidate.sourceDigest)throw new Error('Image archive identity mismatch')
 return'sha256:'+hash
}
export async function deployRelease({manifestPath,server,run=runCommand}){
 if(server!=='relay-host'||typeof run!=='function')throw new Error('Explicit relay-host deployment required')
 const verified=await verifyRelease(manifestPath),c=verified.candidate
 const directory=await mkdtemp(join(root,'data/native-ui-release-deploy-'));await chmod(directory,0o700)
 const remote='/opt/dsh-web-control/native-release/'+verified.releaseHash.slice(0,16)+'-'+randomBytes(4).toString('hex'),helperSha256=sha(await readFile(helper))
 await checked(run,ssh(server,['mkdir','-m','700','-p',remote]),'Remote directory')
 await checked(run,['scp','-q',helper,server+':'+remote+'/remote.py'],'Helper upload')
 await checked(run,ssh(server,['python3','-c',"import hashlib,sys; assert hashlib.sha256(open(sys.argv[1],'rb').read()).hexdigest()==sys.argv[2]",remote+'/remote.py',helperSha256]),'Helper integrity')
 const backup=JSON.parse(await checked(run,ssh(server,['python3',remote+'/remote.py','backup',remote]),'Online backup'))
 if(backup.kind!=='native-ui-backup'||backup.status!=='PASS'||backup.previousImage!==oldImage||!/^[a-f0-9]{64}$/.test(backup.manifestSha256??''))throw new Error('Invalid online backup receipt')
 const rollback={schema:1,kind:'native-ui-rollback',server,remote,helperSha256,backupManifestSha256:backup.manifestSha256,previousImage:oldImage,releaseHash:verified.releaseHash}
 const rollbackPath=join(directory,'rollback.json');await writeFile(rollbackPath,JSON.stringify(rollback,null,2),{mode:0o600,flag:'wx'})
 const archive=join(directory,'candidate.tar')
 await checked(run,['docker','image','save','--platform','linux/amd64','--output',archive,c.image.id],'Candidate export')
 const manifest=JSON.parse(await checked(run,['tar','-xOf',archive,'manifest.json'],'Image archive inspection'))
 if(!Array.isArray(manifest)||manifest.length!==1||!/^blobs\/sha256\/[a-f0-9]{64}$|^[a-f0-9]{64}\.json$/.test(manifest[0]?.Config??''))throw new Error('Invalid image config path')
 const config=await checked(run,['tar','-xOf',archive,manifest[0].Config],'Image config inspection')
 const plan={runtimeImage:archiveIdentity(manifest,config,c),sourceDigest:c.sourceDigest,archiveSha256:await hashFile(archive),localImage:c.image.id,releaseHash:verified.releaseHash}
 const planPath=join(directory,'activation.json');await writeFile(planPath,JSON.stringify(plan,null,2),{mode:0o600,flag:'wx'})
 await checked(run,['scp','-q',archive,planPath,server+':'+remote+'/'],'Candidate upload')
 // Recheck every local gate after potentially slow export/upload before activation.
 await verifyRelease(manifestPath)
 const activation=JSON.parse(await checked(run,ssh(server,['python3',remote+'/remote.py','activate',remote,backup.manifestSha256]),'Relay activation'))
 if(activation.status!=='PASS'||activation.runtimeImage!==plan.runtimeImage)throw new Error('Invalid activation receipt')
 const result={...activation,directory,remote,rollbackPath,rollbackSha256:await hashFile(rollbackPath),releaseHash:verified.releaseHash,image:plan,createdAt:new Date().toISOString()}
 await writeFile(join(directory,'result.json'),JSON.stringify(result,null,2),{mode:0o600,flag:'wx'})
 return result
}
export async function rollbackRelease({manifestPath,manifestSha256,server,run=runCommand}){
 const bytes=await readFile(manifestPath),m=JSON.parse(bytes)
 if(server!=='relay-host'||m.server!==server||m.schema!==1||m.kind!=='native-ui-rollback'||sha(bytes)!==manifestSha256||m.previousImage!==oldImage||!/^\/opt\/dsh-web-control\/native-release\/[a-f0-9]{16}-[a-f0-9]{8}$/.test(m.remote)||!/^[a-f0-9]{64}$/.test(m.backupManifestSha256)||m.helperSha256!==sha(await readFile(helper)))throw new Error('Explicit verified rollback manifest required')
 await checked(run,ssh(server,['python3','-c',"import hashlib,sys; assert hashlib.sha256(open(sys.argv[1],'rb').read()).hexdigest()==sys.argv[2]",m.remote+'/remote.py',m.helperSha256]),'Rollback helper integrity')
 return JSON.parse(await checked(run,ssh(server,['python3',m.remote+'/remote.py','rollback',m.remote,m.backupManifestSha256]),'Rollback'))
}
