import {resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {buildCandidate,verifyCandidate} from './native-ui-candidate.mjs'
export {buildCandidate,verifyCandidate}
import {deployRelease,rollbackRelease} from './native-ui-deploy.mjs'
import {verifyRelease,sealRelease} from './native-ui-gates.mjs'
export {deployRelease,rollbackRelease}
export {verifyRelease,sealRelease,reviewCodeDigest} from './native-ui-gates.mjs'
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2),value=name=>{const i=args.indexOf('--'+name);if(i<0||!args[i+1]||args[i+1].startsWith('--'))throw new Error('Missing --'+name);return args[i+1]}
 const mode=value('mode')
 if(mode==='candidate')console.log(JSON.stringify(await buildCandidate({outputDir:value('output'),artifactsDir:value('artifacts'),startupDir:value('startup'),legacyDir:value('legacy'),platform:value('platform')})))
 else if(mode==='smoke'){const{smokeCandidate}=await import('./native-ui-smoke.mjs');console.log(JSON.stringify(await smokeCandidate(value('manifest'))))}
 else if(mode==='verify'){const v=await verifyRelease(value('manifest'));console.log(JSON.stringify({status:'PASS',releaseHash:v.releaseHash,image:v.candidate.image,uiRevision:v.candidate.ui.revision}))}
 else if(mode==='seal'){const v=await sealRelease({candidateManifestPath:value('candidate'),smokePath:value('smoke'),reviewPath:value('review'),outputPath:value('output')});console.log(JSON.stringify({status:'PASS',releaseHash:v.releaseHash}))}
 else if(mode==='deploy')console.log(JSON.stringify(await deployRelease({manifestPath:value('manifest'),server:value('server')})))
 else if(mode==='rollback')console.log(JSON.stringify(await rollbackRelease({manifestPath:value('manifest'),manifestSha256:value('sha256'),server:value('server')})))
 else throw new Error('Unsupported release mode; no deployment is permitted without release gates')
}
