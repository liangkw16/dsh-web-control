import { symbols, type Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox'

/** Cordis creates a new traceable proxy for every service lookup. Its exported
 * original symbol gives stable identity without accessing provider internals. */
export function currentFileProviderIdentity(provider: Context['fs']): object {
  return (provider as unknown as Record<symbol, object>)[symbols.original] ?? provider
}

/** Only published rc.2 local providers. A compatible-looking remote provider is
 * not permission to reinterpret its execution paths on this machine. */
export function supportsCurrentFiles(ctx: Pick<Context, 'fs'>): boolean {
  if (!['darwin', 'linux'].includes(process.platform) || !ctx.fs) return false
  const prototype = Object.getPrototypeOf(ctx.fs)
  if (prototype !== LocalFileSystem.prototype && prototype !== SandboxedFileSystem.prototype) return false
  return ['resolve', 'contains', 'processPath', 'processPathFromHostPath', 'stat', 'lstat'].every(method => !Object.hasOwn(ctx.fs, method))
}
