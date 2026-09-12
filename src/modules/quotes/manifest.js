module.exports = Object.freeze({
  code: 'quotes',
  routePrefix: '/quotes',
  dependencies: Object.freeze(['inventory', 'contacts']),
  loadPublicRouter: () => require('../../routes/publicQuotes.routes'),
  loadRouter: () => require('../../routes/quotes.routes'),
})
