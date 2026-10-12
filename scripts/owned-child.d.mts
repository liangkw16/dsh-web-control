import type { ChildProcess } from 'node:child_process'
export function stopOwned(child: ChildProcess | undefined, graceMs?: number): Promise<void>
