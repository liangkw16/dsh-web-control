import { expect, test } from 'vitest'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
test('isolated public stock gateway two-client outcomes, replay and observer disposal', async () => {
  const node26 = process.execPath
  const output = await new Promise<string>((done, reject) => {
    const child = spawn(node26, ['scripts/compat.mjs', '--surface', 'web', '--task8-streams'], { cwd: resolve(import.meta.dirname, '../..'), env: { ...process.env, WEB_CONTROL_PNPM_CLI: (process.env.WEB_CONTROL_PNPM_CLI ?? process.env.npm_execpath ?? resolve(import.meta.dirname,'../../node_modules/pnpm/bin/pnpm.mjs')) } })
    let result = '', diagnostics = ''; child.stdout.on('data', chunk => { result += chunk }); child.stderr.on('data', chunk => { diagnostics += chunk })
    child.on('error', reject); child.on('close', code => code === 0 ? done(result) : reject(new Error(result + diagnostics)))
  })
  // The launcher emits an ownership record before its final one-line result.
  const lines = output.trim().split('\n')
  const evidence = JSON.parse(lines.at(-1)!)
  expect(evidence.surface).toBe('web')
  expect(evidence.supported).toBe(true)
  for (const name of ['events.two-client-first-wins', 'events.local-first-wins', 'events.pending-replay', 'events.question-choice-text-result', 'session.query-dispose-keeps-task', 'fixture.cleanup']) expect(evidence.probe.checks.find((check: { name: string }) => check.name === name)).toMatchObject({ ok: true })
}, 180_000)
