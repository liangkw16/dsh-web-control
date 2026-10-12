import { defineConfig } from 'tsdown'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
const require = createRequire(import.meta.url)
const resolve = require.resolve
const { version } = require('./package.json')
const hostEntry = `host-${version}`
if (!/^[0-9A-Za-z.-]+$/.test(version) || !readFileSync(new URL('./cordis.patch.yml', import.meta.url), 'utf8').includes(`name: ./dist/${hostEntry}.js`)) throw new Error('Bundle Host entry must match the complete package version')

export default defineConfig([
  { define: { 'process.env.WS_NO_BUFFER_UTIL': '"1"', 'process.env.WS_NO_UTF_8_VALIDATE': '"1"' }, entry: { index: 'src/index.ts', [hostEntry]: 'src/index.ts' }, platform: 'node', format: 'esm', dts: true, clean: true,
    outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
    deps: { onlyBundle: false, neverBundle: [/^@deepseek-ai\//, /^node:/] } },
  { alias: { qrcode: resolve('qrcode/lib/browser.js') }, entry: { 'client/index': 'src/client/index.ts' }, platform: 'browser', format: 'cjs', dts: true, clean: false,
    outExtensions: () => ({ js: '.js' }),
    deps: { onlyBundle: false, neverBundle: [/^@deepseek-ai\//, 'react'] },
    outputOptions: {
      banner: 'window.__ModuleLoader__.load({ id: "dsh-web-control", factory: (require) => { const module = { exports: {} }; const exports = module.exports;',
      footer: 'return module.exports; } });',
    } },
])
