import { expect, test } from 'vitest'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import {readFile} from 'node:fs/promises'
test('isolated public Host files: actual provider, current reads and symlink boundary', async () => {
  const output = await new Promise<string>((done, reject) => {
    const root=resolve(import.meta.dirname,'../..')
    const child = spawn(process.execPath, ['node_modules/@playwright/test/cli.js','test','--config','tests/e2e/native-ui.config.ts','--grep','native current-file scope confines'], { cwd: root, env:process.env })
    let result = '', diagnostics = ''; child.stdout.on('data', chunk => { result += chunk }); child.stderr.on('data', chunk => { diagnostics += chunk })
    child.on('error', reject); child.on('close', code => code === 0 ? done(result) : reject(new Error(result + diagnostics)))
  })
  const owner=output.split('\n').find(line=>line.startsWith('{"directory":'))
  expect(owner).toBeDefined()
  const evidence=JSON.parse(await readFile(resolve(JSON.parse(owner!).directory,'evidence.json'),'utf8'))
  expect(evidence).toMatchObject({status:'PASS',releaseGate:'PASS',counts:{starts:0,stops:0,prompts:0},cleanup:{sockets:0,hostExited:true},cleanupErrors:[]})
}, 180_000)
