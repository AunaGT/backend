module.exports = Object.freeze({
  code: 'payroll',
  dependencies: Object.freeze(['hr']),
  routePrefix: '/payroll',
  loadRouter: () => require('../../routes/payroll.routes'),
})
