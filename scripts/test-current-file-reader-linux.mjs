import { mkdtemp, mkdir, copyFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'

const root = resolve(import.meta.dirname, '..')
const stage = await mkdtemp(join(tmpdir(), 'dsh-current-reader-linux-'))
const name = `dsh-current-reader-${randomUUID()}`
const image = process.env.WEB_CONTROL_LINUX_TEST_IMAGE || 'dsh-web-control-native:f496416aa7169a6e'
const sources = ['packages/plugin/src/current-files/local-reader.ts', 'packages/plugin/tests/current-file-reader.test.ts']
try {
  for (const path of sources) {
    await mkdir(join(stage, path, '..'), { recursive: true })
    await copyFile(join(root, path), join(stage, path))
  }
  const result = spawnSync('docker', ['run', '--rm', '--name', name, '--platform', 'linux/amd64',
    '--mount', `type=bind,source=${stage},target=/source,readonly`, '--entrypoint', 'sh', image, '-ec',
    'mkdir /tmp/reader; cd /tmp/reader; cp -R /source/packages .; npm init -y >/dev/null; npm install --ignore-scripts --no-audit --no-fund vitest@5.0.3 >/dev/null; node --version; node node_modules/vitest/vitest.mjs run packages/plugin/tests/current-file-reader.test.ts --maxWorkers=2'], { stdio: 'inherit' })
  process.exitCode = result.status ?? 1
} finally {
  // Exact owned container only, including when npm/test startup failed.
  spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' })
  await rm(stage, { recursive: true, force: true })
}
