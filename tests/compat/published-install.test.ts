import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'

test('packed deliverable contains only this plugin and public entry imports', () => {
  const result = spawnSync(process.execPath, ['scripts/check-package.mjs'], { encoding: 'utf8' })
  expect(result.status, result.stdout + result.stderr).toBe(0)
})

test('unsupported surface fails without starting or modifying any profile', () => {
  const result = spawnSync(process.execPath, ['scripts/compat.mjs', '--surface', 'headless'], { encoding: 'utf8' })
  expect(result.status).toBe(2)
  expect(result.stderr).toContain('surface must be web or desktop')
})

test('core peers cannot be silently installed into a test profile', () => {
  const workspace = readFileSync('pnpm-workspace.yaml', 'utf8')
  expect(workspace).toContain('autoInstallPeers: false')
  const plugin = JSON.parse(readFileSync('packages/plugin/package.json', 'utf8'))
  expect(plugin.dependencies).toBeUndefined()
  expect(plugin.dsh.bundle.patch).toEqual(['./cordis.patch.yml'])
  expect(plugin.dsh.client.platform).toBe('web')
})

// Desktop may be running user work. The verifier must never launch or attach it.
test('Desktop command explicitly defers live validation without an App launch', () => {
  const runner = readFileSync('scripts/compat.mjs', 'utf8')
  const branch = runner.slice(runner.indexOf("if (surface === 'desktop')"), runner.indexOf('  const runtime ='))
  expect(branch).toContain("evidence.status = 'NOT_RUN'")
  expect(branch).not.toMatch(/spawn\(|connectOverCDP|user-data-dir/)
})

import { verifyRuntimeImports } from '../../scripts/package-import-guard.ts'
test('bundled commonjs factories and Node builtins retain literal public import validation', () => {
  expect(() => verifyRuntimeImports('var require_utils$1 = __commonJSMin((exports) => { const stream = require("stream"); }); require_utils$1();')).not.toThrow()
  for (const source of [
    'require_unknown();', 'require(variable);', 'import(variable);',
    'var require_utils = __commonJSMin(() => require("@deepseek-ai/dsh/src/private")); require_utils();',
    'var require_utils = __commonJSMin(() => require(variable)); require_utils();',
    'module.require("deepseek-harness/src/private");', 'require("arbitrary-package");',
  ]) expect(() => verifyRuntimeImports(source)).toThrow()
})

test('packaged bundle uses a Host file specifier unique to the complete package version', async () => {
  const { readFileSync } = await import('node:fs'); const { execFileSync } = await import('node:child_process'); const { resolve } = await import('node:path')
  const manifest = JSON.parse(readFileSync('packages/plugin/package.json', 'utf8'))
  const archive = resolve(process.env.WEB_CONTROL_CANDIDATE_DIR ?? 'dist', `${manifest.name}-${manifest.version}.tgz`)
  const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' })
  expect(entries).toContain(`package/dist/host-${manifest.version}.js`)
  const patch = execFileSync('tar', ['-xOzf', archive, 'package/cordis.patch.yml'], { encoding: 'utf8' })
  expect(patch).toContain(`name: ./dist/host-${manifest.version}.js`)
})
