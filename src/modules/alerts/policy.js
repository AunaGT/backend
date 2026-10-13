const DEFAULT_ALERT_MODULE = 'inventory'

const ALERT_TYPE_MODULES = Object.freeze({
  'stock bajo': 'inventory',
  'sin stock': 'inventory',
  vencimiento: 'inventory',
  precio: 'inventory',
  'cobro vencido': 'receivables',
  'pago pendiente a proveedor': 'merchandise',
  'pedido retrasado': 'orders',
  'cotización por vencer': 'quotes',
  'cierre de caja pendiente': 'cash-closure',
  'nómina pendiente': 'payroll',
})

function normalizeTypeName(name) {
  return String(name || '').trim().toLocaleLowerCase('es')
}

function moduleForAlertType(name) {
  return ALERT_TYPE_MODULES[normalizeTypeName(name)] || DEFAULT_ALERT_MODULE
}

function availableAlertTypes(types = [], modules = []) {
  const enabled = new Set(
    modules
      .filter((module) => module?.effectiveEnabled)
      .map((module) => String(module.code))
  )

  return types
    .map((type) => ({ ...type, moduleCode: moduleForAlertType(type.name) }))
    .filter((type) => enabled.has(type.moduleCode))
}

function withAlertModule(alert) {
  return { ...alert, moduleCode: moduleForAlertType(alert?.type?.name) }
}

module.exports = {
  ALERT_TYPE_MODULES,
  availableAlertTypes,
  moduleForAlertType,
  withAlertModule,
}
