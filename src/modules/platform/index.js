const registry = require('./registry')
const service = require('./service')
const { requireAnyModule, requireModule } = require('./middleware')

module.exports = { ...registry, ...service, requireAnyModule, requireModule }
