const { spawn } = require('node:child_process')
const { workerLaunch } = require('./fiscal-worker-launch')
let launch
try {
  launch = workerLaunch(process.env, process.argv.slice(2))
} catch {
  process.stderr.write('FISCAL_LOCAL_DATABASE_REQUIRED: usa el modo local y una base desechable autorizada.\n')
  process.exit(64)
}
const child = spawn(process.execPath, launch.args, { ...launch.options, stdio: 'inherit' })
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal))
child.on('error', () => { process.stderr.write('FISCAL_LOCAL_WORKER_FAILED\n'); process.exitCode = 1 })
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 1) })
