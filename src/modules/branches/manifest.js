module.exports = Object.freeze({
  code: 'branches',
  dependencies: Object.freeze([]),
  routePrefix: '/branches',
  loadRouter: () => require('../../routes/branches.routes'),
})
