module.exports = Object.freeze({
  code: 'catalogs',
  dependencies: Object.freeze([]),
  routePrefix: '/catalogs',
  loadRouter: () => require('../../routes/catalogs.routes'),
})
