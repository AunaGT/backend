/**
 * Interfaz pública del módulo piloto. Durante la migración el router existente
 * se conserva detrás del manifiesto; controllers y servicios pueden moverse
 * internamente después sin cambiar routes/index.js.
 */
module.exports = Object.freeze({
  code: 'promotions',
  routePrefix: '/promotions',
  dependencies: Object.freeze(['sales', 'inventory']),
  loadRouter: () => require('./routes'),
})
