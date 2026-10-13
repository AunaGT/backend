module.exports = Object.freeze({
  code: 'config',
  dependencies: Object.freeze([]),
  routePrefix: '/settings',
  loadRouter: () => require('./routes'),
})
