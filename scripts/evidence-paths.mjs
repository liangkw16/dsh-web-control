/** Claim empty run directories before launching children; inherited tokens identify that run only. */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { randomUUID } from 'node:crypto'
const variables = { browser: 'WEB_CONTROL_EVIDENCE_DIR', system: 'WEB_CONTROL_SYSTEM_DIR', performance: 'WEB_CONTROL_PERFORMANCE_DIR' }
export function claimEvidenceDirectory(kind, fallbackParent = 'data/runs') {
  const variable = variables[kind]
  if (!variable) throw new Error('Unknown evidence kind')
  const tokenVariable = variable + '_TOKEN', inheritedToken = process.env[tokenVariable]
  let directory = process.env[variable] && resolve(process.env[variable])
  if (directory && inheritedToken) {
    const owner = JSON.parse(readFileSync(join(directory, 'invocation.json'), 'utf8'))
    if (owner.token !== inheritedToken || owner.kind !== kind || owner.evidenceDir !== directory) throw new Error('Evidence ownership mismatch')
    return directory
  }
  if (!directory) {
    const parent = resolve(fallbackParent); mkdirSync(parent, { recursive: true })
    directory = mkdtempSync(join(parent, kind + '-'))
  } else {
    mkdirSync(directory, { recursive: true })
    if (readdirSync(directory).length) throw new Error('Evidence directory must be unused: ' + directory)
  }
  const token = randomUUID()
  writeFileSync(join(directory, 'invocation.json'), JSON.stringify({ kind, token, argv: process.argv, pid: process.pid, startedAt: new Date().toISOString(), evidenceDir: directory }, null, 2), { flag: 'wx' })
  process.env[variable] = directory; process.env[tokenVariable] = token
  console.log(`${kind} evidence: ${directory}`)
  return directory
}
export function browserEvidenceDirectories() {
  const browser = claimEvidenceDirectory('browser')
  // --list runs in a separate child whose new token cannot reach the wrapper parent.
  // Keep the parent's explicit performance path reserved for the actual run.
  if (process.argv.includes('--list')) {
    const inventoryPerformance = resolve(browser, 'inventory-performance')
    if (process.env.WEB_CONTROL_PERFORMANCE_DIR !== inventoryPerformance) {
      process.env.WEB_CONTROL_PERFORMANCE_DIR = inventoryPerformance
      delete process.env.WEB_CONTROL_PERFORMANCE_DIR_TOKEN
    }
  }
  const performance = claimEvidenceDirectory('performance', browser)
  return { browser, performance }
}
