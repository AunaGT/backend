const { createReport, column: c, section: s, metric: m, chart } = require('../reportModel')
const {D,exact,baseUnit,dimension,quantityTotal}=require('../quantities')
const n = value => Number(value || 0)
const stockColumns = label => [c(label[0], label[1]), c('skus', 'Productos', 'integer'), c('value', 'Valor', 'money')]
function stockSections(data, prefix = '') {
  return [s(`${prefix}by-branch`, 'Inventario actual por sucursal', stockColumns(['branch', 'Sucursal']), data.byBranch || []),
    s(`${prefix}by-warehouse`, 'Inventario actual por almacén', stockColumns(['warehouse', 'Almacén']), data.byWarehouse || [])]
}
function buildInventoryReport(data, meta) {
  const rows = data.products.filter(p=>p.kind!=='SERVICE').map(p => ({ product: p.name, category: p.category?.name || 'Sin categoría', dimension:dimension(p),unit:baseUnit(p),stock:exact(p.stock),cost:exact(p.cost),value:D(p.stock).mul(D(p.cost)).toDecimalPlaces(2).toNumber() }))
  const value = rows.reduce((sum, r) => sum + r.value, 0)
  return createReport(meta, { id: 'inventory', title: 'Inventario actual',
    summary: [m('products', 'Productos', rows.length), m('units', 'Cantidad (misma unidad)', quantityTotal(rows,'stock'),'decimal'), m('value', 'Valor a costo', value, 'money')],
    sections: [s('detail', 'Detalle de inventario', [c('product', 'Producto'), c('category', 'Categoría'), c('unit','Unidad base'),c('stock', 'Existencia', 'decimal',6), c('cost', 'Costo por unidad base'), c('value', 'Valor', 'money')], rows, { value }), ...stockSections(data)],
    charts: [chart('by-warehouse', 'Valor actual por almacén', data.byWarehouse || [], 'warehouse', 'value')], notes: ['Existencias al preparar el reporte; no es un cierre histórico.'] })
}
function buildSuppliersReport(data, meta) {
  const rows = data.suppliers.map(p => ({ supplier: p.name, contact: p.contact || null, phone: p.phone || null, email: p.email || null,
    paymentTerm: p.paymentTermName || null, products: p.productCount, units: p.stockUnits, value: p.inventoryValue }))
  const cols = [c('supplier', 'Proveedor'), c('contact', 'Contacto'), c('phone', 'Teléfono'), c('email', 'Correo'), c('paymentTerm', 'Condiciones de pago'),
    c('products', 'Productos', 'integer'), c('value', 'Inventario a costo', 'money')]
  const ranked = [...rows].filter(r => r.value > 0).sort((a, b) => b.value - a.value).slice(0, 15)
  return createReport(meta, { id: 'suppliers', title: 'Proveedores',
    summary: [m('suppliers', 'Proveedores', data.summary.totalSuppliers), m('active', 'Activos', data.summary.activeSuppliers),
      m('without-products', 'Sin productos', data.summary.withoutProducts), m('value', 'Inventario asociado', data.summary.totalInventoryValue, 'money')],
    sections: [s('detail', 'Detalle de proveedores', cols, rows), s('by-inventory', 'Top 15 por valor de inventario', cols.filter(c => ['supplier','products','units','value'].includes(c.id)), ranked),
      s('without-products', 'Proveedores sin productos', cols.filter(c => ['supplier','contact','phone'].includes(c.id)), rows.filter(r => r.products === 0))],
    charts: [chart('by-inventory', 'Top 15 por inventario asociado', ranked, 'supplier', 'value')], notes: ['El valor corresponde al inventario actual asociado, no a saldos por pagar ni al desempeño del proveedor.'] })
}
function buildProductsReport(data, meta) {
  if (data.catalogType==='services') {
    const rows=data.products.map(p=>({product:p.name,category:p.category?.name || 'Sin categoría',unit:p.service_unit_label,decimals:p.quantity_decimals,price:n(p.price),available:p.available_for_sale}))
    return createReport(meta,{id:'products',title:'Análisis de servicios',summary:[m('services','Servicios',rows.length),m('available','Disponibles para venta',rows.filter(r=>r.available).length)],sections:[s('detail','Catálogo de servicios',[c('product','Servicio'),c('category','Categoría'),c('unit','Unidad de cobro'),c('decimals','Decimales','integer'),c('price','Precio','money'),c('available','Disponible','boolean')],rows)],notes:['Catálogo empresarial. Los servicios no tienen existencias ni valoración de inventario; no incluye costeo de prestación.']})
  }
  const cols = [c('product', 'Producto'), c('category', 'Categoría'), c('supplier', 'Proveedor'), c('unit','Unidad base'),c('stock', 'Existencia', 'decimal',6), c('cost', 'Costo por unidad base'),
    c('price', 'Precio de venta', 'money'), c('margin', 'Margen de precio %', 'percent'), c('value', 'Valor a costo', 'money'), c('retail', 'Valor a precio público', 'money')]
  const project = products => products.map(p => ({ product: p.name, category: p.category?.name || 'Sin categoría', supplier: p.supplier?.name || null,
    unit:baseUnit(p),stock:exact(p.units),cost:exact(p.cost), price: n(p.price), margin: p.marginPct, value: p.invValue, retail: p.retailValue }))
  const mixCols = [c('skus', 'Productos', 'integer'), c('invValue', 'Valor a costo', 'money'), c('retailValue', 'Valor público', 'money')]
  return createReport(meta, { id: 'products', title: 'Análisis de productos',
    summary: [m('products', 'Productos', data.summary.totalSkus), m('value', 'Valor a costo', data.summary.inventoryValue, 'money'),
      m('retail', 'Valor a precio público', data.summary.retailInventoryValue, 'money'), m('margin', 'Margen ponderado de precio', data.summary.weightedMarginPct, 'percent'), m('flags', 'Revisar precios', data.summary.pricingFlags)],
    sections: [s('detail', 'Detalle del catálogo', cols, project(data.products)),
      s('by-category', 'Valor actual por categoría', [c('category', 'Categoría'), ...mixCols, c('marginPct', 'Margen %', 'percent')], data.categoryRows),
      s('by-supplier', 'Valor actual por proveedor', [c('supplier', 'Proveedor'), ...mixCols], data.supplierRows),
      s('top-inventory', 'Top 15 por valor a costo', cols, project(data.topByInv)), s('top-retail', 'Top 15 por valor público', cols, project(data.topByRetail)),
      s('tight-margins', 'Top 15 márgenes de precio más ajustados', cols, project(data.tightMargins)), ...stockSections(data, 'stock-')],
    charts: [chart('by-category', 'Inventario a costo por categoría', data.categoryRows, 'category', 'invValue')],
    notes: ['Análisis de existencias y precios actuales. No representa rotación ni ventas del período. Los rankings incluyen hasta 15 productos.'] })
}
module.exports = { buildInventoryReport, buildSuppliersReport, buildProductsReport }
