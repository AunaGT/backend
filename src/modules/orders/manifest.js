module.exports = Object.freeze({
  code: 'orders',
  dependencies: Object.freeze(['inventory', 'contacts']),
  routePrefix: '/orders',
  loadRouter: () => require('../../routes/orders.routes'),
})
