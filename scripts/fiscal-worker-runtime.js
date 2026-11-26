const { resolve } = require('node:path')
const { localDatabaseUrl } = require('../src/modules/fiscal/localPolicy')
// This entry point must not bypass the launcher's environment-file restriction.
if (!process.permission || process.permission.has('fs.read', resolve(__dirname, '../.env'))) {
  process.stderr.write('FISCAL_LOCAL_RUNTIME_REQUIRED\n'); process.exit(64)
}
const url = localDatabaseUrl(process.env), args = process.argv.slice(2)
const fs = require('node:fs'), existsSync = fs.existsSync
// Node 22 throws on denied existsSync probes; Prisma expects inaccessible files to be absent.
fs.existsSync = function (file) {
  if (!process.permission.has('fs.read', file)) return false
  return existsSync.call(this, file)
}
const { PrismaClient } = require('@prisma/client')
const { randomUUID } = require('node:crypto')
const { processNextFiscalOperation } = require('../src/modules/fiscal/worker')
const { createLocalSimulator } = require('../src/modules/fiscal/localSimulator')
const db = new PrismaClient({ datasources: { db: { url } } }), workerId = `local-${randomUUID()}`, simulator = createLocalSimulator()
let stopped = false
process.on('SIGTERM', () => { stopped = true }); process.on('SIGINT', () => { stopped = true })
async function main() {
  do {
    const state = await processNextFiscalOperation(db, { workerId, simulator })
    process.stdout.write(JSON.stringify({ event: 'fiscal_local_worker', state, simulationOnly: true, certified: false }) + '\n')
    if (state === 'idle' && !args.includes('--once')) await new Promise(resolve => setTimeout(resolve, 1000))
  } while (!stopped && !args.includes('--once'))
}
main().catch(() => { process.stderr.write('FISCAL_LOCAL_WORKER_FAILED\n'); process.exitCode = 1 }).finally(() => db.$disconnect())
