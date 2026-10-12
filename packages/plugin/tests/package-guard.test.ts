import { expect, test } from 'vitest'
import { verifyRuntimeImports } from '../../../scripts/package-import-guard.ts'

test('allows intended own source regions while checking public imports', () => {
  expect(() => verifyRuntimeImports(`
//#region ../protocol/src/types.ts
class ProtocolError extends Error {}
//#endregion
//#region src/identity.ts
import { credentialKey } from '@deepseek-ai/dsh-credentials';
const module = await import('@deepseek-ai/dsh-llm');
const react = require('react');
`)).not.toThrow()
})

test.each([
  `import { x } from '@deepseek-ai/dsh-credentials/src/index.ts'`,
  `export { x } from '@deepseek-ai/dsh-credentials/src/index.ts'`,
  `await import('@deepseek-ai/dsh-credentials/src/index.ts')`,
  `require('@deepseek-ai/dsh-credentials/src/index.ts')`,
  `await import('./src/private.ts')`,
  `import x from 'unauthorized-runtime'`,
  `await import(runtimeName)`,
  `//#region ../deepseek-harness/packages/credentials/src/index.ts`,
  `//#region ../ZCode/src/index.ts`,
  `//#region ../happy/src/index.ts`,
  `//#region node_modules/.pnpm/@deepseek-ai+dsh-credentials@0.2.0-rc.2/node_modules/@deepseek-ai/dsh-credentials/lib/index.js`,
  `//#region ../../other/src/index.ts`,
])('rejects prohibited runtime or bundled source: %s', content => {
  expect(() => verifyRuntimeImports(content)).toThrow()
})

for (const loader of ['module.require', `module['require']`, '__require', '__require2', 'require$1', '__webpack_require__', '(0, module.require)']) {
  for (const specifier of [
    `'@deepseek-ai/dsh-credentials/src/index.ts'`,
    `'unauthorized-runtime'`,
    'runtimeName',
  ]) {
    test(`rejects prohibited specifier through ${loader}: ${specifier}`, () => {
      expect(() => verifyRuntimeImports(`${loader}(${specifier})`)).toThrow()
    })
  }
  test(`permits published public imports through ${loader}`, () => {
    expect(() => verifyRuntimeImports(`${loader}('@deepseek-ai/dsh-credentials')`)).not.toThrow()
  })
}
