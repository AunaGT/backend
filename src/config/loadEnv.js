const fs = require('fs')
const path = require('path')
const dotenv = require('dotenv')

const projectRoot = path.resolve(__dirname, '../..')

function resolveEnvFile(env = process.env) {
  if (env.ENV_FILE) {
    return path.isAbsolute(env.ENV_FILE)
      ? env.ENV_FILE
      : path.resolve(projectRoot, env.ENV_FILE)
  }

  return ['.env', 'env']
    .map((name) => path.join(projectRoot, name))
    .find((candidate) => fs.existsSync(candidate)) || null
}

const envFile = resolveEnvFile()
if (envFile) dotenv.config({ path: envFile, override: false, quiet: true })

module.exports = { envFile, resolveEnvFile }
