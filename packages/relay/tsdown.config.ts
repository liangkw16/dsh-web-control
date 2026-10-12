import { defineConfig } from 'tsdown'
export default defineConfig({
  entry: {
    server: 'src/server.ts',
    cli: 'src/cli.ts',
    backup: 'src/backup.ts',
    health: 'src/health.ts',
    auth: 'src/auth.ts',
    origin: 'src/origin.ts',
    leases: 'src/leases.ts',
    'host-routes': 'src/host-routes.ts',
    'ui-assets': 'src/ui-assets.ts',
  },
  platform: 'node',
  format: 'esm',
  dts: { eager: true },
  clean: true,
  deps: {
    alwaysBundle: ['@dsh-web-control/protocol'],
    neverBundle: ['better-sqlite3', 'ws'],
  },
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
})
