module.exports = Object.freeze({
  code: 'transfers',
  dependencies: Object.freeze(['inventory', 'branches']),
  routePrefix: '/transfers',
  loadRouter: () => require('./routes'),
})
