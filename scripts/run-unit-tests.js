const { readdirSync } = require('node:fs')
const { join, relative } = require('node:path')
const { spawnSync } = require('node:child_process')

const rootDir = join(__dirname, '..')
const testsDir = join(rootDir, 'tests')
const testFiles = readdirSync(testsDir, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('.test.js'))
  .map((entry) => relative(rootDir, join(testsDir, entry.name)))
  .sort()

if (testFiles.length === 0) {
  console.error('No se encontraron archivos tests/*.test.js')
  process.exit(1)
}

const result = spawnSync(
  process.execPath,
  ['--require', './tests/setup-env.js', '--test', ...testFiles],
  {
    cwd: rootDir,
    env: process.env,
    stdio: 'inherit',
  }
)

if (result.error) {
  console.error(result.error)
  process.exit(1)
}

process.exit(result.status ?? 1)
