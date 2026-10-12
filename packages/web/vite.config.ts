import { defineConfig } from 'vite'
import {createRequire} from 'node:module'
import {readFileSync} from 'node:fs'
import {dirname,join} from 'node:path'
const require=createRequire(import.meta.url)
export default defineConfig({
  plugins: [{ name: 'browser-only-artifact', generateBundle(_options, bundle) {
    const modules = new Set<string>()
    for (const chunk of Object.values(bundle)) {
      if (chunk.type !== 'chunk') continue
      if (/\b(?:require\(['"]node:|from\s*['"]node:|__vite-browser-external|Electron)\b/.test(chunk.code)) throw new Error('Forbidden browser runtime')
      for (const id of Object.keys(chunk.modules)) {
        if (/^(?:node:)|\/packages\/(?:plugin|relay)\/|\/dsh-(?:agent|app-boot|client-connection|session-controller)\//.test(id)) throw new Error(`Host runtime in browser graph: ${id}`)
        modules.add(id.replace(/^.*\/node_modules\//, 'node_modules/').replace(/^.*\/packages\//, 'packages/'))
      }
    }
    this.emitFile({ type: 'asset', fileName: 'browser-modules.json', source: JSON.stringify([...modules].sort(), null, 2) })
    this.emitFile({type:'asset',fileName:'licenses/entry-zod.txt',source:readFileSync(join(dirname(require.resolve('zod/package.json')),'LICENSE'),'utf8')})
  } }],
  build: {
    sourcemap: false,
  },
})
