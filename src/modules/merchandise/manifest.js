module.exports = Object.freeze({
  code: 'merchandise',
  dependencies: Object.freeze(['inventory', 'contacts']),
  routePrefix: '/incoming-merchandise',
  loadRouter: () => require('../../routes/incomingMerchandise.routes'),
})
