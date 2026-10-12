/** Task21 phase-owned command ledger. No production actions. */
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const [phase, command, ...args] = process.argv.slice(2);
if (!phase || !command || !/^[\w-]+$/.test(phase)) throw new Error('phase command argv required');
const directory = resolve('data/task21', phase);
await mkdir(directory, { recursive: false });
const startedAt = new Date().toISOString();
const child = spawn(command, args, { cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
let output = ''; child.stdout.on('data', bytes => { output += bytes; process.stdout.write(bytes) }); child.stderr.on('data', bytes => { output += bytes; process.stderr.write(bytes) });
const invocation = { argv: [command, ...args], runnerPid: process.pid, pid: child.pid, cwd: process.cwd(), startedAt };
await writeFile(join(directory, 'invocation.json'), JSON.stringify(invocation, null, 2));
const code = await new Promise((done, reject) => { child.once('error', reject); child.once('close', done) });
await writeFile(join(directory, 'output.log'), output);
await writeFile(join(directory, 'result.json'), JSON.stringify({ ...invocation, endedAt: new Date().toISOString(), exit: code }, null, 2));
process.exitCode = code ?? 1;
