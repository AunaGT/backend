const { resolve } = require('node:path')
const { localDatabaseUrl } = require('../src/modules/fiscal/localPolicy')

function workerLaunch(env, args) {
  if (!args.includes('--local-simulation') || args.some(arg => !['--local-simulation', '--once'].includes(arg))) throw Error('Local mode required')
  const url = localDatabaseUrl(env), root = resolve(__dirname, '..')
  // Prisma implicitly probes .env: allow source/dependencies, not the project root or environment files.
  const readPaths = ['src', 'node_modules', 'package.json', 'prisma/schema.prisma', 'scripts/fiscal-worker-runtime.js'].map(file => resolve(root, file))
  return {
    args: ['--permission', '--allow-addons', '--allow-child-process', ...readPaths.map(file => `--allow-fs-read=${file}`), resolve(__dirname, 'fiscal-worker-runtime.js'), ...args],
    options: { cwd: root, env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', TZ: 'UTC', AUNA_FISCAL_LOCAL_TESTS: 'approved', AUNA_FISCAL_LOCAL_DATABASE_URL: url } },
  }
}
module.exports = { workerLaunch }
