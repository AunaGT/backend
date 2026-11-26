// Intercept only .env reads; never inspect a real environment file in this regression.
const fs = require('node:fs'), original = fs.readFileSync
fs.readFileSync = function (file, ...args) {
  if (/(?:^|\/)\.env$/.test(String(file))) {
    process.stderr.write('APPLICATION_ENV_READ\n')
    return Buffer.from('SYNTHETIC_ENV_CANARY=loaded\n')
  }
  return original.call(this, file, ...args)
}
