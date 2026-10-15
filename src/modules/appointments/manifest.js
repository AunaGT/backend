module.exports = Object.freeze({
  code: 'appointments',
  dependencies: Object.freeze(['branches']),
  routePrefix: '/appointments',
  loadRouter: () => require('./routes'),
})
