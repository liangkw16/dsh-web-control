/** Compatibility CLI: local candidate only; no implicit current/latest deployment. */
import {buildCandidate} from './native-ui-candidate.mjs'
const args=process.argv.slice(2)
if(!args.includes('--local-candidate'))throw new Error('Use native-ui-release.mjs with an explicit mode; this command cannot publish or deploy')
const value=name=>{const i=args.indexOf('--'+name);if(i<0||!args[i+1]||args[i+1].startsWith('--'))throw new Error('Native candidates require explicit --'+name);return args[i+1]}
console.log(JSON.stringify(await buildCandidate({outputDir:value('output'),artifactsDir:value('artifacts'),startupDir:value('startup'),legacyDir:value('legacy'),platform:value('platform')})))
