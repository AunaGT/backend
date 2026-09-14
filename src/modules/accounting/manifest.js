module.exports = Object.freeze({
  code: 'accounting',
  dependencies: Object.freeze([]),
  routePrefix: '/accounting',
  loadRouter: () => require('./routes'),
})
