module.exports = Object.freeze({
  code: 'receivables',
  dependencies: Object.freeze(['contacts']),
  routePrefix: '/receivables',
  loadRouter: () => require('./routes'),
})
