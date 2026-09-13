module.exports = Object.freeze({
  code: 'receivables',
  dependencies: Object.freeze(['sales', 'contacts']),
  routePrefix: '/receivables',
  loadRouter: () => require('../../routes/receivables.routes'),
})
