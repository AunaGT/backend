module.exports = Object.freeze({
  code: 'users',
  dependencies: Object.freeze([]),
  routePrefix: '/auth',
  // Login, refresh, logout y /me comparten este router. Las operaciones de
  // administración de usuarios aplican el guard dentro de usuarios.routes.
  guardAtMount: false,
  loadRouter: () => require('./routes'),
})
