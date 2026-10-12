import { spawn } from 'node:child_process'
import { claimEvidenceDirectory } from './evidence-paths.mjs'
claimEvidenceDirectory('system')
const launcher = process.env.npm_execpath
if (!launcher) throw new Error('Run this runner with pnpm run test:system')
// Playwright sets FORCE_COLOR for its workers; remove NO_COLOR to avoid their conflict.
const childEnv = { ...process.env, FORCE_COLOR: '0' }
delete childEnv.NO_COLOR
const run = args => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [launcher, ...args], { stdio: 'inherit', env: childEnv })
  child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`System phase exited ${code}`)))
})
// One process/test worker; browser engines are serial and authenticated tracing is off.
const phaseArgs = process.argv.slice(2)
if (phaseArgs[0] === '--') phaseArgs.shift()
await run(['exec', 'vitest', 'run', 'tests/integration', '--maxWorkers=1', '--no-file-parallelism', '--disableConsoleIntercept', ...phaseArgs])
await run(['--filter', '@dsh-web-control/web', 'build'])
await run(['exec', 'playwright', 'test', 'tests/e2e/reconnect.spec.ts', '--workers=1', '--reporter=list'])
