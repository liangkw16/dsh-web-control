/** Operator-side setup export. Never accepts secret values in argv. Node >=24. */
import { readFile, writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { parsePairingConfig, pairingConfigLimit } from '../packages/plugin/src/client/pairing-config.ts'
try {
  const { values } = parseArgs({ options: { origin: { type: 'string' }, 'secret-file': { type: 'string' }, output: { type: 'string' } } })
  if (!values.origin || !values['secret-file'] || !values.output) throw new Error()
  let source
  if (values['secret-file'] === '-') {
    const chunks = []; let size = 0
    for await (const chunk of process.stdin) { size += chunk.length; if (size > pairingConfigLimit) throw new Error(); chunks.push(chunk) }
    source = Buffer.concat(chunks).toString('utf8')
  } else source = await readFile(values['secret-file'], 'utf8')
  const config = parsePairingConfig(JSON.stringify({ kind: 'dsh-web-control-connection', version: 1, relayOrigin: values.origin, enrollmentSecret: source.trim() }))
  await writeFile(values.output, JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  console.log('Connection configuration created. Import it in the local DSH Web Control settings; keep the file private.')
} catch {
  console.error('Could not create connection configuration. Use --origin <https-origin> --secret-file <path|-> --output <new-file>; check the inputs and choose a new output file.')
  process.exitCode = 1
}
