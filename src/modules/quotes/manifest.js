module.exports = Object.freeze({
  code: 'quotes',
  routePrefix: '/quotes',
  dependencies: Object.freeze(['inventory', 'contacts']),
  loadPublicRouter: () => require('./public.routes'),
  loadRouter: () => require('./routes'),
})
