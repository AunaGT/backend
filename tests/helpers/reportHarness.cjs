async function withMocks(mocks, target, run) {
  const ids = [...Object.keys(mocks), require.resolve(target)]
  const saved = new Map(ids.map(id => [id, require.cache[id]]))
  const before = new Set(Object.keys(require.cache))
  try {
    for (const [id, exports] of Object.entries(mocks)) require.cache[id] = { id, filename: id, loaded: true, exports }
    delete require.cache[require.resolve(target)]
    return await run(require(target))
  } finally {
    const directory = require('node:path').dirname(target)
    for (const id of Object.keys(require.cache)) if (!before.has(id) && id.startsWith(directory + '/')) delete require.cache[id]
    for (const [id, value] of saved) { if (value) require.cache[id] = value; else delete require.cache[id] }
  }
}
function jsonResponse() {
  return { statusCode: 200, body: null, status(code) { this.statusCode = code; return this }, json(value) { this.body = value; return this } }
}
module.exports = { withMocks, jsonResponse }
