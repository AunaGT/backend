const { assertExternalSendingAllowed } = require('./contract')

async function sendInfile() {
  // Intentionally no HTTP client: real transport requires a new authorization.
  assertExternalSendingAllowed()
}
module.exports = { sendInfile }
