module.exports = Object.freeze({
  code: 'cash-closure',
  dependencies: Object.freeze(['sales']),
  routePrefix: '/cash-closures',
  loadRouter: () => require('./routes'),
})
