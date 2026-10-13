module.exports = Object.freeze({
  code: 'hr',
  dependencies: Object.freeze(['branches']),
  routePrefix: '/hr',
  loadRouter: () => require('./routes'),
})
