const { Prisma } = require('@prisma/client')

function fail(message, status = 400) { throw Object.assign(new Error(message), { status }) }

function parseCatalogKind(raw) {
  const kind = raw == null ? 'STANDARD' : String(raw).trim().toUpperCase()
  if (!['STANDARD', 'KIT', 'SERVICE'].includes(kind)) fail('Tipo de artículo inválido')
  return kind
}

function commercialQuantity(raw, rules, { allowZero = false } = {}) {
  const kind = parseCatalogKind(rules.kind ?? rules.item_kind)
  const decimals = kind === 'SERVICE' ? rules.quantity_decimals : 0
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 4) fail('Precisión de cantidad inválida')
  if (typeof raw === 'number' && !Number.isSafeInteger(raw)) fail('Envía la cantidad decimal como cadena')
  if (typeof raw !== 'string' && typeof raw !== 'number' && !Prisma.Decimal.isDecimal(raw)) fail('Cantidad inválida')
  const text = String(raw).trim()
  if (text.length > 128 || !/^\d+(?:\.\d+)?$/.test(text)) fail('Cantidad inválida')
  const qty = new Prisma.Decimal(text)
  if (!qty.isFinite() || qty.lt(0) || (!allowZero && qty.eq(0)) || qty.gt('99999999.9999')) fail('Cantidad fuera de rango')
  if (qty.decimalPlaces() > decimals) fail('Cantidad excede los decimales permitidos')
  return qty
}

function assertServiceFields(payload) {
  const unit = payload.service_unit_label
  if (typeof unit !== 'string' || !unit.trim() || unit.trim().length > 50) fail('Ingresa una unidad de cobro de hasta 50 caracteres')
  if (!Number.isInteger(payload.quantity_decimals) || payload.quantity_decimals < 0 || payload.quantity_decimals > 4) fail('Decimales debe ser un entero entre 0 y 4')
  for (const key of ['stock', 'min_stock', 'cost', 'supplier_id', 'tracks_expiry', 'stock_assembled', 'kit_components', 'bom_components', 'components', 'warehouse_id', 'location_id', 'brand', 'size']) {
    if (Object.hasOwn(payload, key)) fail(`El servicio no admite ${key}`)
  }
}

function lineSnapshot(product) {
  const kind = parseCatalogKind(product.kind ?? product.item_kind)
  if (kind === 'SERVICE') assertServiceFields({ service_unit_label: product.service_unit_label ?? product.unit_label, quantity_decimals: product.quantity_decimals })
  return {
    item_name: product.item_name ?? product.name,
    item_kind: kind,
    unit_label: kind === 'SERVICE' ? String(product.service_unit_label ?? product.unit_label).trim() : 'unidad',
    quantity_decimals: kind === 'SERVICE' ? product.quantity_decimals : 0,
  }
}

function assertPhysicalItem(product) {
  if (!product) fail('Artículo no encontrado', 404)
  if (parseCatalogKind(product.kind ?? product.item_kind) === 'SERVICE') fail('El servicio no admite operaciones de inventario físico')
}

async function assertServicesEnabled(tx, companyId) {
  if (!companyId) fail('Empresa requerida', 403)
  const setting = await tx.systemSetting.findUnique({ where: { company_id_key: { company_id: companyId, key: 'inventory_services_enabled' } } })
  if (String(setting?.value ?? 'false').toLowerCase() !== 'true') fail('Los servicios están desactivados para esta empresa', 403)
}

async function assertPhysicalProducts(tx, productIds, branchId) {
  const ids = [...new Set(productIds.map(String))]
  if (!ids.length) return
  if (!branchId) fail('Sucursal requerida para inventario físico')
  const cached=require('./checkoutContext').checkoutProducts(tx,ids,{branchId})
  const rows = cached?[...cached.values()]:await tx.product.findMany({
    where: { id:{in:ids}, company:{branches:{some:{id:String(branchId)}}} },
    select:{id:true,kind:true},
  })
  const byId = new Map(rows.map(row=>[String(row.id),row]))
  for (const id of ids) assertPhysicalItem(byId.get(id))
}

module.exports = { parseCatalogKind, commercialQuantity, lineSnapshot, assertPhysicalItem, assertPhysicalProducts, assertServiceFields, assertServicesEnabled }
