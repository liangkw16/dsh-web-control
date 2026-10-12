import { access, readFile, realpath, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { resolve, relative } from 'node:path'
import { ProtocolError } from '@dsh-web-control/protocol'
import {loadUiRelease} from './ui-assets.ts'
/** Bounded entry inventory, refreshed if the deployment changes the entry. */
export function staticReadiness(directory: string): () => Promise<void> {
  let cached: { entry: string; stamp: string; files: string[] } | undefined
  return async () => {
    try {
      if(await loadUiRelease(directory))return
      const root = await realpath(directory)
      const entry = await realpath(resolve(root, 'index.html'))
      if (relative(root, entry).startsWith('..')) throw new Error()
      const info = await stat(entry)
      if (!info.isFile() || info.size === 0 || info.size > 1024 * 1024) throw new Error()
      const stamp = `${info.mtimeMs}:${info.ctimeMs}:${info.size}`
      if (!cached || cached.entry !== entry || cached.stamp !== stamp) {
        const html = await readFile(entry, 'utf8')
        if(/name=["']dsh-ui-release["']/.test(html))throw new Error('Versioned release inventory missing')
        const files = [...html.matchAll(/(?:src|href)=["'](\/assets\/[A-Za-z0-9_.-]+)["']/g)].map(match => match[1]!)
        if (files.length > 128) throw new Error()
        cached = { entry, stamp, files: [...new Set(files)] }
      }
      for (const path of ['index.html', ...cached.files.map(path => path.slice(1))]) {
        const file = await realpath(resolve(root, path))
        if (relative(root, file).startsWith('..') || !(await stat(file)).isFile()) throw new Error()
        await access(file, constants.R_OK)
      }
    } catch { throw new ProtocolError('STORAGE_ERROR') }
  }
}
