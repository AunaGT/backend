#!/usr/bin/env node

const path = require('path')
const { spawnSync } = require('child_process')

require('../src/config/loadEnv')

const prismaRoot = path.dirname(require.resolve('prisma/package.json'))
const prismaCli = path.join(prismaRoot, 'build', 'index.js')
const result = spawnSync(process.execPath, [prismaCli, ...process.argv.slice(2)], {
  cwd: path.resolve(__dirname, '..'),
  env: process.env,
  stdio: 'inherit',
})

if (result.error) {
  console.error(`No se pudo ejecutar Prisma: ${result.error.message}`)
  process.exit(1)
}

process.exit(result.status ?? 1)
