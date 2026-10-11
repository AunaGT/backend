const { createReport, column: c, section: s, metric: m, chart } = require('../reportModel')
const salesColumns = label => [c(label[0], label[1]), c('ventas', 'Tickets', 'integer'), c('unidades', 'Unidades físicas', 'integer'), c('revenue', 'Ingreso neto', 'money')]
function buildSalesReport(data, meta) {
  return createReport(meta, { id: 'sales', title: 'Reporte de ventas',
    summary: [m('gross', 'Ventas brutas', data.totalRevenueGross, 'money'), m('returns', 'Devoluciones', data.totalReturned, 'money'),
      m('net', 'Ventas netas', data.totalRevenue, 'money'), m('cost', 'Costo de mercancía vendida', data.totalCost, 'money'), m('profit', 'Margen bruto', data.totalProfit, 'money'),
      m('units', 'Unidades físicas vendidas', data.unidadesTotales), m('tickets', 'Tickets', data.tickets), m('average', 'Ticket promedio', data.ticketPromedio, 'money')],
    sections: [s('by-branch', 'Ventas por sucursal', salesColumns(['branch', 'Sucursal']), data.salesByBranch),
      s('top-products', 'Top 10 partidas por ingreso bruto', [c('name', 'Bien o servicio'), c('unit','Unidad'),c('ventas', 'Cantidad', 'decimal',4), c('revenue', 'Ingreso bruto', 'money')], data.topProducts),
      ...(data.quantitiesByUnit ? [s('quantities','Cantidades por tipo y unidad',[c('type','Tipo'),c('unit','Unidad'),c('quantity','Cantidad','decimal',4)],data.quantitiesByUnit)] : []),
      s('by-category', 'Ingresos brutos por categoría', [c('category', 'Categoría'), c('revenue', 'Ingreso bruto', 'money')], data.categories),
      s('by-method', 'Ventas por método de pago', salesColumns(['method', 'Método']), data.salesByMethod),
      s('by-period', data.useDaily ? 'Ventas por día' : 'Ventas por mes', salesColumns(['periodo', 'Período']), data.salesByPeriod),
      s('by-cashier', 'Ventas por cajero', salesColumns(['cajero', 'Cajero']), data.salesByCashier)],
    charts: [chart('by-period', 'Ventas netas por período', data.salesByPeriod, 'periodo', 'revenue', 'money', 'line'),
      chart('by-method', 'Ventas netas por método', data.salesByMethod, 'method', 'revenue', 'money', 'donut')],
    notes: ['El ranking incluye hasta 10 productos. Categorías y productos muestran ingresos brutos de las líneas; los demás ingresos descuentan devoluciones.'] })
}
function buildFinancialReport(data, meta) {
  const concepts = [ ['Ventas brutas', data.totalRevenueGross], ['Devoluciones', -data.totalReturned], ['Ventas netas', data.totalRevenue],
    ['Costo de mercancía vendida', data.totalCost], ['Margen bruto', data.totalProfit],...(data.totalServiceRevenue!=null ? [['Ingresos netos de bienes',data.totalGoodsRevenue],['Ingresos netos de servicios',data.totalServiceRevenue]] : []) ].map(([concept, amount]) => ({ concept, amount }))
  const attributable = data.purchasesAttributable !== false
  return createReport(meta, { id: 'financial', title: 'Resultado del negocio',
    summary: [m('net', 'Ventas netas', data.totalRevenue, 'money'), m('profit', 'Margen bruto', data.totalProfit, 'money'),
      m('margin', 'Margen bruto', data.grossMarginPct, 'percent'), m('inventory', 'Inventario actual propio', data.inventoryValueOwned, 'money'),
      ...(attributable ? [m('purchases', 'Compras registradas · empresa', data.purchasesPeriod, 'money')] : [])],
    sections: [s('concepts', 'Resultados del período', [c('concept', 'Concepto'), c('amount', 'Monto', 'money')], concepts),
      s('by-category', 'Rentabilidad bruta por categoría', [c('category', 'Categoría'), c('revenue', 'Ingreso bruto', 'money'), c('cost', 'Costo', 'money'), c('profit', 'Margen', 'money'), c('marginPct', 'Margen %', 'percent')], data.categoryProfitability),
      ...(attributable ? [s('purchases-by-supplier', 'Compras registradas por proveedor · empresa', [c('supplier', 'Proveedor'), c('lines', 'Líneas', 'integer'), c('units', 'Unidades', 'integer'), c('amount', 'Monto', 'money')], data.purchasesBySupplier)] : []),
      s('stock-by-branch', 'Inventario actual por sucursal', [c('branch', 'Sucursal'), c('skus', 'Productos', 'integer'), c('units', 'Unidades', 'integer'), c('value', 'Valor', 'money')], data.byBranch || []),
      s('stock-by-warehouse', 'Inventario actual por almacén', [c('warehouse', 'Almacén'), c('skus', 'Productos', 'integer'), c('units', 'Unidades', 'integer'), c('value', 'Valor', 'money')], data.byWarehouse || [])],
    charts: [chart('concepts', 'Ventas, costo y margen', concepts.filter(r => ['Ventas netas', 'Costo de mercancía vendida', 'Margen bruto'].includes(r.concept)), 'concept', 'amount')],
    notes: ['No es un estado financiero contable completo. El inventario es actual, no un cierre histórico.',
      ...(data.serviceLines ? ['El ingreso de servicios no incluye costeo de prestación; el margen mostrado no es utilidad neta de servicios.'] : []),
      ...(attributable ? ['Las compras registradas no tienen sucursal: se muestran como total de empresa.'] : ['Compras y aperturas no disponibles por sucursal: el registro histórico no identifica su sucursal.'])] })
}
module.exports = { buildSalesReport, buildFinancialReport }
