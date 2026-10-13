module.exports = Object.freeze({
  code: 'orders',
  dependencies: Object.freeze(['inventory', 'contacts']),
  routePrefix: '/orders',
  loadPublicRouter: () => require('./public.routes'),
  loadRouter: () => require('./routes'),
})
