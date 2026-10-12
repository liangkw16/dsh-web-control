import { expect, test } from 'vitest'
import { spawn } from 'node:child_process'
import { stopOwned } from '../../scripts/owned-child.mjs'
test('captured child exit is awaited and already exited child is untouched', async () => {
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 40)); console.log('ready'); setInterval(() => {}, 1000)"])
  await new Promise(resolve => child.stdout!.once('data', resolve))
  await stopOwned(child); expect(child.exitCode).toBe(0)
  await stopOwned(child); expect(child.exitCode).toBe(0)
})
test('timeout reports failure without signalling any discovered process', async () => {
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)"])
  await new Promise(resolve => child.stdout!.once('data', resolve))
  try { await expect(stopOwned(child, 20)).rejects.toThrow('cleanup timed out'); expect(child.exitCode).toBeNull() }
  finally { const exit = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGKILL'); await exit }
})
