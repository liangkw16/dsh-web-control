/** Stop only the ChildProcess captured by this run; never discover or signal another process. */
export async function stopOwned(child, graceMs = 10000) {
  if (!child) return
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.removeListener('exit', onExit); reject(new Error('owned child cleanup timed out')) }, graceMs)
    const onExit = () => { clearTimeout(timer); resolve() }
    child.once('exit', onExit)
  })
  child.kill('SIGTERM')
  await exited
  if (child.exitCode === null && child.signalCode === null) throw new Error('owned child did not exit')
}
