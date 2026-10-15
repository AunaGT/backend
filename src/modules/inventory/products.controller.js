/**
 * Copyright (c) 2026 Diego Patzán. All Rights Reserved.
 * 
 * This source code is licensed under a Proprietary License.
 * Unauthorized copying, modification, distribution, or use of this file,
 * via any medium, is strictly prohibited without express written permission.
 * 
 * For licensing inquiries: GitHub @dpatzan2
 */
const { prisma, prismaTransaction } = require('../../models/prisma')
const PDFDocument = require('pdfkit')
// Luxon DateTime (single import; removed duplicate that caused startup SyntaxError)
const { DateTime } = require('luxon')
const { createClient } = require('@supabase/supabase-js')

// Reuse shared stock alert service
const { ensureStockAlert } = require('../../services/stockAlerts')
const { requireBranch, branchWhere } = require('../../middlewares/tenant')
const { requestScope } = require('../appointments/access')
const { saveServiceProfile } = require('../appointments/profiles')
const { withAgendaTransaction } = require('../appointments/application')
const { parseCatalogKind, assertServiceFields, assertServicesEnabled, assertPhysicalItem } = require('../../services/catalogItemRules')
const { validMoney, checkText } = require('../../utils/importValidation')
const { ensureBranchStockRows } = require('../../services/stockAvailability')
const {
  applyBranchDelta, branchLocationStock, clearBranchLocations, defaultLocationId, salesLocationId,
} = require('../../services/stockLocations')

/**
 * Fija stock/min_stock del producto EN LA SUCURSAL dada y ajusta el espejo
 * products.stock por el delta. Devuelve la fila de la sucursal actualizada.
 */
async function setBranchStock(tx, productId, branchId, { stock, minStock }, ctx = {}) {
  await ensureBranchStockRows(tx, [productId], branchId)
  const key = { product_id_branch_id: { product_id: productId, branch_id: branchId } }
  const row = await tx.productStock.findUnique({ where: key })
  const data = {}
  if (minStock !== undefined) data.min_stock = Number(minStock)
  if (stock !== undefined) data.stock = Number(stock)
  const updated = await tx.productStock.update({ where: key, data })
  if (stock !== undefined) {
    const delta = Number(stock) - Number(row?.stock || 0)
    if (delta !== 0) {
      await tx.product.update({ where: { id: productId }, data: { stock: { increment: delta } } })
      // La misma diferencia por ubicación: entra a la de recepción y, si baja,
      // sale primero de la menos accesible.
      await applyBranchDelta(tx, [[String(productId), Math.abs(delta)]], branchId, Math.sign(delta), {
        reason: 'MANUAL_ADJUST', refType: 'product', refId: String(productId), adjust: true, ...ctx,
        // Un ajuste que sube existencia no trae lote. Se excluye refType
        // 'product_lot': ahí el lote es justamente lo que se está editando.
        autoLotForTracked: ctx.refType !== 'product_lot',
      })
    }
  }
  return updated
}

/**
 * Alcance de un listado de inventario: lo que eligió la pantalla (?branch_id,
 * ?warehouse_id, ?location_id) manda sobre el selector global. Sin sucursal el
 * alcance es toda la empresa.
 */
function listScope(req) {
  const allowed = req.branchIds || req.userBranchIds || (req.branchId ? [req.branchId] : [])
  const wanted = req.query?.branch_id ? String(req.query.branch_id) : null
  if (wanted && wanted !== 'all' && !allowed.includes(wanted)) {
    const err = new Error('Sin acceso a esa sucursal')
    err.status = 403
    throw err
  }
  return {
    // 'all' = toda la empresa; el almacén y la ubicación siguen valiendo ahí
    // (el JOIN los limita a las sucursales que el usuario puede ver).
    branchId: wanted === 'all' ? null : (wanted || req.branchId || null),
    allowed,
    warehouseId: req.query?.warehouse_id ? String(req.query.warehouse_id) : null,
    locationId: req.query?.location_id ? String(req.query.location_id) : null,
  }
}

/**
 * De qué habla el documento: "Todas las sucursales" o
 * "Central · Bodega Central · GENERAL". Va impreso en la exportación para que
 * un archivo suelto no se confunda con el de otra sucursal.
 */
async function scopeLabel(req, scope) {
  const partes = []
  if (scope.branchId) {
    const b = await prisma.branch.findUnique({ where: { id: scope.branchId }, select: { name: true } })
    partes.push(b?.name || 'Sucursal')
  } else {
    partes.push('Todas las sucursales')
  }
  if (scope.warehouseId) {
    const w = await prisma.warehouse.findUnique({ where: { id: scope.warehouseId }, select: { name: true } })
    if (w) partes.push(w.name)
  }
  if (scope.locationId) {
    const l = await prisma.stockLocation.findUnique({ where: { id: scope.locationId }, select: { code: true } })
    if (l) partes.push(l.code)
  }
  return partes.join(' · ')
}

/**
 * Filtros del listado de inventario. Lo usan la pantalla y la exportación: si
 * exportás lo que estás viendo, tiene que salir lo mismo que ves.
 */
function buildProductListWhere(req, scope) {
  const { includeDeleted, deletedOnly, search, category, supplier, forSale } = req.query || {}
  const forSaleOnly =
    forSale === 'true' || forSale === '1' || String(forSale || '').toLowerCase() === 'yes'

  const where = deletedOnly === 'true' ? { deleted: true } : includeDeleted === 'true' ? {} : { deleted: false }
  where.company_id = req.companyId
  const catalog = req.query.catalog_type || 'goods'
  if (!['goods','services','all'].includes(catalog)) throw Object.assign(new Error('Tipo de catálogo inválido'), { status:400 })
  if (catalog === 'services') where.kind = 'SERVICE'
  else if (catalog === 'goods') where.kind = { not:'SERVICE' }

  // ?in_branch=1 → solo los productos que esa sucursal maneja (tienen fila de
  // stock propia), en vez de todo el catálogo de la empresa en cero.
  const inBranchOnly = req.query.in_branch === '1' || req.query.in_branch === 'true'
  if (inBranchOnly && scope.branchId && catalog !== 'services') {
    where.branch_stocks = { some: { branch_id: scope.branchId } }
    if (catalog === 'all') { where.AND = [{ OR:[{kind:'SERVICE'},{branch_stocks:where.branch_stocks}] }]; delete where.branch_stocks }
  }
  // Acotado a un almacén o anaquel, lo que se lista es lo que está ahí: un
  // catálogo entero en cero no dice nada de una ubicación.
  if ((scope.warehouseId || scope.locationId) && catalog !== 'services') {
    where.location_stocks = { some: { stock: { not: 0 }, ...scopeLocationWhere(scope) } }
    if (catalog === 'all') {
      where.AND = [...(where.AND || []), { OR: [{ kind:'SERVICE' }, { location_stocks:where.location_stocks }] }]
      delete where.location_stocks
    }
  }
  if (forSaleOnly) where.available_for_sale = true
  if (search) {
    where.OR = [
      { name: { contains: String(search), mode: 'insensitive' } },
      { brand: { contains: String(search), mode: 'insensitive' } },
      { barcode: { contains: String(search), mode: 'insensitive' } },
    ]
  }
  if (category && category !== 'all') {
    where.category = { name: { equals: String(category), mode: 'insensitive' } }
  }
  if (supplier) where.supplier_id = String(supplier)
  return where
}

/** Where de ubicación para el alcance dado (sirve para filtrar y para sumar). */
function scopeLocationWhere(scope) {
  return {
    ...(scope.locationId ? { location_id: scope.locationId } : {}),
    location: {
      warehouse: {
        ...(scope.warehouseId ? { id: scope.warehouseId } : {}),
        ...(scope.branchId ? { branch_id: scope.branchId } : { branch_id: { in: scope.allowed } }),
      },
    },
  }
}

/**
 * Sustituye stock/min_stock por los valores de la sucursal activa en las
 * respuestas de productos (la forma del JSON no cambia). En vista consolidada
 * (sin sucursal) se devuelven los totales espejo tal cual.
 */
async function overlayBranchStock(items, branchId) {
  if (!branchId || !items?.length) return items
  if (items.every(p => p.kind === 'SERVICE')) return items.map(p => ({...p,in_branch:true}))
  const rows = await prisma.productStock.findMany({
    where: { branch_id: branchId, product_id: { in: items.filter(p => p.kind !== 'SERVICE').map((p) => p.id) } },
    select: { product_id: true, stock: true, min_stock: true },
  })
  const byId = new Map(rows.map((r) => [r.product_id, r]))
  return items.map((p) => {
    if (p.kind === 'SERVICE') return {...p,in_branch:true}
    const s = byId.get(p.id)
    // in_branch distingue "hay cero" de "esta sucursal no lo maneja": sin esto
    // la UI no puede ofrecer empezar a manejarlo.
    return { ...p, stock: s ? s.stock : 0, min_stock: s ? s.min_stock : p.min_stock, in_branch: Boolean(s) }
  })
}

/**
 * El stock que corresponde al alcance elegido: de un anaquel, de un almacén, de
 * una sucursal o de toda la empresa (ahí el espejo `products.stock` ya es el total).
 */
async function overlayScopedStock(items, scope) {
  if (!items?.length) return items
  if (items.every(p => p.kind === 'SERVICE')) return items.map(p => ({...p,in_branch:true}))
  if (!scope.warehouseId && !scope.locationId) return overlayBranchStock(items, scope.branchId)

  const rows = await prisma.productStockLocation.findMany({
    where: { product_id: { in: items.filter(p => p.kind !== 'SERVICE').map((p) => p.id) }, ...scopeLocationWhere(scope) },
    select: { product_id: true, stock: true, min_stock: true },
  })
  const agg = new Map()
  for (const r of rows) {
    const a = agg.get(r.product_id) || { stock: 0, min_stock: 0 }
    a.stock += r.stock
    a.min_stock += r.min_stock
    agg.set(r.product_id, a)
  }
  return items.map((p) => {
    if (p.kind === 'SERVICE') return {...p,in_branch:true}
    const a = agg.get(p.id)
    return { ...p, stock: a ? a.stock : 0, min_stock: a ? a.min_stock : 0, in_branch: Boolean(a) }
  })
}
const { getTimezone } = require('../../utils/getTimezone')
const { getBrandingForPdf, setupReportPdf, ensureReportSpace, drawReportTable, finishReportPdf, reportLines } = require('../../utils/pdfBranding')

// Bulk import service
const { parseExcel, validateBulkData, bulkCreateProducts, generateTemplateWithCatalogs } = require('../../services/bulkImport')
const { runImportStream } = require('../../utils/importStream')
const {
  parseKind,
  replaceProductBom,
  BOM_INCLUDE,
  getAvailabilityBatchWithKits,
  assembleKit,
  restoreStockMap,
  deductStockMap,
} = require('../../services/bomStock')
const { generateLotCode, syncLotExpiryAlerts } = require('../../services/lots')

// Inicializar cliente de Supabase con service role key (solo para backend)
const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
const supabase = supabaseUrl && supabaseServiceKey 
  ? createClient(supabaseUrl, supabaseServiceKey)
  : null

exports.list = async (req, res, next) => {
  try {
    if (req.query.deletedOnly !== 'true' && (req.query.catalog_type === 'services' || req.query.catalog_type === 'all')) await assertServicesEnabled(prisma,req.companyId)
    const page = Math.max(1, Number(req.query.page ?? 1))
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize ?? 20)))
    const scope = listScope(req)
    const where = buildProductListWhere(req, scope)
    
    const totalItems = await prisma.product.count({ where })
    let summary
    if (req.query.includeSummary === 'true') {
      const service = req.query.catalog_type === 'services'
      const counts = await Promise.all((service ? [{available_for_sale:true},{available_for_sale:false},{quantity_decimals:{gt:0}}] : [{ available_for_sale: true }, { kind: 'KIT' }, { tracks_expiry: true }]).map(filter => prisma.product.count({ where: { AND: [where, filter] } })))
      summary = service ? {total:totalItems,forSale:counts[0],notForSale:counts[1],fractional:counts[2]} : { total: totalItems, forSale: counts[0], kits: counts[1], tracksExpiry: counts[2] }
    }
    const totalPages = Math.max(1, Math.ceil(totalItems / pageSize))
    const safePage = Math.min(page, totalPages)
    
    const products = await prisma.product.findMany({
      where,
      include: { category: true, supplier: true, status: true },
      orderBy: { name: 'asc' },
      skip: (safePage - 1) * pageSize,
      take: pageSize,
    })
    
    const nextPage = safePage < totalPages ? safePage + 1 : null
    const prevPage = safePage > 1 ? safePage - 1 : null

    res.json({
      items: await overlayScopedStock(products, scope),
      ...(summary ? { summary } : {}),
      page: safePage,
      pageSize,
      totalPages,
      totalItems,
      nextPage,
      prevPage
    })
  } catch (e) { next(e) }
}

function validateServiceCommercialFields(payload) {
  const errors = []
  checkText(payload, {name:150,barcode:50,description:4000,service_unit_label:50}, errors)
  for (const key of ['price','price_wholesale','price_promotion']) {
    if (payload[key] === undefined || (key !== 'price' && (payload[key] === null || payload[key] === ''))) continue
    if (payload[key] === null || payload[key] === '' || !validMoney(Number(payload[key])) || (key === 'price' && Number(payload[key]) <= 0)) errors.push('Precio inválido o fuera de rango')
  }
  if (errors.length) throw Object.assign(new Error(errors.join('; ')), {status:400})
}

exports.create = async (req, res, next) => {
  try {
    const payload = req.body || {}
    const kind = parseCatalogKind(payload.kind)
    if (payload.schedule_profile !== undefined && kind !== 'SERVICE') throw Object.assign(new Error('Solo los servicios admiten configuración de agenda'), { status: 400 })
    if (kind === 'SERVICE') {
      await assertServicesEnabled(prisma,req.companyId)
      assertServiceFields(payload)
      validateServiceCommercialFields(payload)
      const category = await prisma.productCategory.findFirst({where:{id:Number(payload.category_id),company_id:req.companyId}})
      if (!category || !String(payload.name || '').trim() || !Number.isFinite(Number(payload.price)) || Number(payload.price) <= 0) throw Object.assign(new Error('Nombre, categoría y precio válidos son requeridos'),{status:400})
      const status = await prisma.stockStatus.findFirst({where:{name:{in:['active','available','Disponible','Activo']}},orderBy:{id:'asc'}})
      if (!status) throw Object.assign(new Error('Estado de catálogo no configurado'),{status:409})
      const data = {company_id:req.companyId,name:String(payload.name).trim(),category_id:category.id,kind,
        service_unit_label:payload.service_unit_label.trim(),quantity_decimals:payload.quantity_decimals,
        price:payload.price,cost:0,stock:0,min_stock:0,supplier_id:null,status_id:status.id,
        barcode:payload.barcode?.trim() || null,description:payload.description || null,image_url:payload.image_url || null,
        available_for_sale:payload.available_for_sale !== false && payload.available_for_sale !== 'false'}
      for (const key of ['price_wholesale','price_promotion']) if (payload[key] != null && payload[key] !== '') {
        if (!Number.isFinite(Number(payload[key])) || Number(payload[key]) < 0) throw Object.assign(new Error('Precio inválido'),{status:400})
        data[key] = payload[key]
      }
      if (payload.promotion_valid_until) {const date=new Date(payload.promotion_valid_until);if(Number.isNaN(date.getTime()))throw Object.assign(new Error('Fecha inválida'),{status:400});data.promotion_valid_until=date}
      const scope = payload.schedule_profile === undefined ? null : requestScope(req)
      const save = async tx => {
        const product = await tx.product.create({data})
        if (scope) await saveServiceProfile(tx, scope, product.id, payload.schedule_profile)
        return product
      }
      const product = scope ? await withAgendaTransaction(prismaTransaction, scope.companyId, save) : await prismaTransaction.$transaction(save)
      return res.status(201).json({product,purchaseLog:null})
    }
    const stock = Number(payload.stock || 0)
    const cost = payload.cost != null ? Number(payload.cost) : 0
    const branchId = requireBranch(req)

    // Preparar payload seguro: normalizar campos y validar
    const safePayload = { ...payload }
    if (!safePayload.supplier_id) return res.status(400).json({ message:'El proveedor es obligatorio para bienes y kits' })
    
    // Remover image_url si está vacío
    if (safePayload.image_url === '' || safePayload.image_url === null) {
      delete safePayload.image_url
    }

    // Normalizar tracks_expiry a boolean (checkboxes/formularios pueden mandar string)
    if (safePayload.tracks_expiry !== undefined) {
      safePayload.tracks_expiry = safePayload.tracks_expiry === true || safePayload.tracks_expiry === 'true'
    }

    // Validar y normalizar supplier_id: debe ser un UUID válido
    if (safePayload.supplier_id !== undefined) {
      const supplierId = String(safePayload.supplier_id).trim()
      // Validar formato UUID básico (8-4-4-4-12 caracteres hex)
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      if (!uuidRegex.test(supplierId)) {
        // Si no es un UUID válido, intentar buscar el proveedor por nombre
        const supplier = await prisma.supplier.findFirst({
          where: {
            name: { equals: supplierId, mode: 'insensitive' },
            deleted: false,
            company_id: req.companyId
          }
        })
        if (supplier) {
          safePayload.supplier_id = supplier.id
        } else {
          return res.status(400).json({ message: `Proveedor no encontrado: ${supplierId}. Debe ser un UUID válido o el nombre de un proveedor existente.` })
        }
      } else {
        const supplier = await prisma.supplier.findFirst({where:{id:supplierId,company_id:req.companyId,deleted:false}})
        if (!supplier) return res.status(400).json({message:'Proveedor no encontrado en esta empresa'})
        safePayload.supplier_id = supplierId
      }
    }

    if (!await prisma.productCategory.findFirst({where:{id:Number(safePayload.category_id),company_id:req.companyId}})) return res.status(400).json({message:'Categoría no encontrada en esta empresa'})
    safePayload.company_id = req.companyId
    const bomComponents = payload.bom_components
    delete safePayload.bom_components
    delete safePayload.kind
    if (kind === 'KIT') {
      safePayload.kind = 'KIT'
    } else {
      safePayload.kind = 'STANDARD'
    }
    // El espejo products.stock arranca en 0; setBranchStock lo sube con el
    // stock inicial de la sucursal (si no, se duplicaría).
    safePayload.stock = 0

    // create product and, if initial stock > 0, create a purchase log in the same transaction
    // Use prismaTransaction (DIRECT_URL) for transactions as pooled connections don't support them
    const result = await prismaTransaction.$transaction(async (tx) => {
      let product
      try {
        product = await tx.product.create({ data: safePayload })
      } catch (prismaError) {
        // Si el error es porque image_url no existe en la base de datos (migración no ejecutada)
        // Remover image_url y reintentar
        if (prismaError.message && (
          prismaError.message.includes('image_url') || 
          prismaError.message.includes('Unknown argument') ||
          prismaError.message.includes('Unknown field')
        )) {
          const fallbackPayload = { ...safePayload }
          delete fallbackPayload.image_url
          product = await tx.product.create({ data: fallbackPayload })
          console.warn('[products.create] image_url no disponible en la base de datos. Ejecuta la migración para habilitar imágenes de productos.')
        } else {
          throw prismaError
        }
      }

      if (kind === 'KIT') {
        if (!bomComponents?.length) {
          const err = new Error('Un kit debe incluir al menos un componente (bom_components)')
          err.status = 400
          throw err
        }
        await replaceProductBom(tx, product.id, bomComponents)
      }

      // El stock inicial vive en la sucursal donde se creó el producto
      const branchStock = await setBranchStock(tx, product.id, branchId, {
        stock: kind === 'KIT' ? 0 : stock,
        minStock: Number(product.min_stock || 0),
      }, { reason: 'INITIAL', userId: req.user?.sub || null })
      product.stock = branchStock.stock

      let purchaseLog = null

      if (stock > 0 && kind !== 'KIT') {
        // supplier_id is required on Product model, but validate to ensure purchase log can be created
        const supplierId = product.supplier_id || payload.supplier_id
        if (!supplierId) {
          throw new Error('supplier_id required when initial stock > 0')
        }

        // Instante real del evento: se guarda en UTC de verdad, tal cual lo da
        // `new Date()`. Convertir a la zona configurada y volver a etiquetar
        // esos números como si fueran UTC (como hacía este bloque antes) corre
        // la marca de tiempo el offset de la zona — 6h en Guatemala — un bug
        // de dato guardado, no solo de cómo se muestra.
        const now = new Date()

        // Stock inicial de un producto nuevo = apertura, nunca una compra
        // operativa del período (mismo criterio que 'INITIAL' en stock_movements).
        purchaseLog = await tx.purchaseLog.create({
          data: {
            product_id: product.id,
            supplier_id: supplierId,
            qty: stock,
            cost: cost,
            date: now,
            source: 'INITIAL',
          },
        })

        // No incrementa total_purchases del proveedor: es saldo de apertura,
        // no una compra real que el proveedor haya despachado.
        await tx.supplier.update({
          where: { id: supplierId },
          data: {
            last_order: now,
          }
        })
      }

      return { product, purchaseLog }
    })

    // Si el producto inicia ya bajo mínimo (o en 0) generar / actualizar alerta
    try {
      const { product } = result
      if (product && product.min_stock != null && Number(product.stock) < Number(product.min_stock)) {
        await ensureStockAlert(prisma, product.id, product.stock, product.min_stock, branchId)
      }
    } catch (e) {
      console.error('post-create ensureStockAlert error', e.message)
    }

    // devolver ambos objetos; purchaseLog será null si no se creó
    res.status(201).json(result)
  } catch (e) { next(e) }
}

exports.getOne = async (req, res, next) => {
  try {
    const item = await prisma.product.findFirst({
      where: { id: req.params.id, company_id: req.companyId },
      include: BOM_INCLUDE,
    })
    if (!item || item.deleted) return res.status(404).json({ message: 'No encontrado' })
    if (req.branchId) {
      const [withBranch] = await overlayBranchStock([item], req.branchId)
      return res.json(withBranch)
    }
    res.json(item)
  } catch (e) { next(e) }
}

exports.getBom = async (req, res, next) => {
  try {
    const product = await prisma.product.findFirst({
      where: { id: req.params.id, deleted: false, company_id: req.companyId },
      select: { id: true, name: true, kind: true },
    })
    if (!product) return res.status(404).json({ message: 'Producto no encontrado' })
    assertPhysicalItem(product)
    if (product.kind !== 'KIT') {
      return res.json({ kind: product.kind, components: [] })
    }
    const components = await prisma.productBomLine.findMany({
      where: { kit_product_id: product.id },
      orderBy: { sort_order: 'asc' },
      include: {
        component_product: {
          select: { id: true, name: true, barcode: true, price: true, stock: true, kind: true },
        },
      },
    })
    res.json({ kind: product.kind, components })
  } catch (e) {
    next(e)
  }
}

exports.updateBom = async (req, res, next) => {
  try {
    const id = req.params.id
    const { components } = req.body || {}
    const updated = await prismaTransaction.$transaction(async (tx) => {
      const product = await tx.product.findFirst({
        where: { id, deleted: false, company_id: req.companyId },
        select: { id: true, kind: true },
      })
      if (!product) {
        const err = new Error('Producto no encontrado')
        err.status = 404
        throw err
      }
      assertPhysicalItem(product)
      if (product.kind !== 'KIT') {
        await tx.product.update({ where: { id }, data: { kind: 'KIT', stock: 0 } })
      }
      return replaceProductBom(tx, id, components)
    })
    res.json({ components: updated })
  } catch (e) {
    next(e)
  }
}

/**
 * POST /api/products/:id/kit/assemble
 * Arma unidades de un kit ahora mismo (body.qty opcional, si no se pasa arma
 * el máximo posible): descuenta los componentes y le da al kit stock propio
 * real (permanente).
 */
exports.assembleKit = async (req, res, next) => {
  try {
    const { id } = req.params
    const { qty } = req.body || {}
    const branchId = requireBranch(req)
    const result = await prismaTransaction.$transaction(async (tx) => {
      const out = await assembleKit(tx, id, qty, branchId)
      await ensureStockAlert(tx, out.product.id, out.product.stock, out.product.min_stock, branchId)
      return out
    })
    res.json(result)
  } catch (e) { next(e) }
}

/**
 * GET /api/products/availability?ids=uuid1,uuid2[&scope=pos]
 * Stock físico, reservado y disponible (stock − reservas ACTIVE).
 *
 * Con `scope=pos` responde además el stock en la ubicación de venta de la
 * sucursal: el punto de venta despacha de ahí, así que el total de la sucursal
 * (que suma bodegas) le miente sobre lo que tiene a mano. Si la sucursal no
 * tiene ubicación de venta configurada, `sales_location.configured` es false y
 * la caja no debe vender hasta que alguien la configure.
 */
exports.availability = async (req, res, next) => {
  try {
    const raw = req.query.ids
    const ids = String(raw || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    if (ids.length === 0) {
      return res.status(400).json({ message: 'Parámetro ids requerido (UUIDs separados por coma)' })
    }
    if (ids.length > 200) {
      return res.status(400).json({ message: 'Máximo 200 productos por consulta' })
    }
    const branchId = requireBranch(req)
    const posScope = String(req.query.scope || '') === 'pos'
    const locationId = posScope ? await salesLocationId(prisma, branchId) : null
    const availability = await getAvailabilityBatchWithKits(ids, null, branchId, { locationId, companyId:req.companyId })
    if (!posScope) return res.json({ availability })
    res.json({
      availability,
      sales_location: { configured: Boolean(locationId), id: locationId },
    })
  } catch (e) {
    next(e)
  }
}

exports.update = async (req, res, next) => {
  try {
    const id = req.params.id
    const payload = req.body || {}

    // Get current product to detect stock changes
    const current = await prisma.product.findFirst({ where: { id, company_id: req.companyId } })
    if (!current || current.deleted) {
      return res.status(404).json({ message: 'Producto no encontrado' })
    }
    if (payload.schedule_profile !== undefined && current.kind !== 'SERVICE') throw Object.assign(new Error('Solo los servicios admiten configuración de agenda'), { status: 400 })
    if (payload.kind !== undefined && (parseCatalogKind(payload.kind) === 'SERVICE') !== (current.kind === 'SERVICE')) throw Object.assign(new Error('No se puede convertir el tipo físico a servicio ni viceversa'),{status:400})
    if (current.kind === 'SERVICE') {
      await assertServicesEnabled(prisma,req.companyId)
      assertServiceFields({...payload,service_unit_label:payload.service_unit_label ?? current.service_unit_label,quantity_decimals:payload.quantity_decimals ?? current.quantity_decimals})
      validateServiceCommercialFields(payload)
      if (payload.category_id !== undefined && !await prisma.productCategory.findFirst({where:{id:Number(payload.category_id),company_id:req.companyId}})) throw Object.assign(new Error('Categoría inválida'),{status:400})
      const data={}
      for(const key of ['name','description','image_url','barcode','category_id','available_for_sale','price','price_wholesale','price_promotion','promotion_valid_until','service_unit_label','quantity_decimals'])if(payload[key]!==undefined)data[key]=payload[key]
      for(const key of ['price','price_wholesale','price_promotion'])if(data[key]!=null&&data[key]!==''&&(!Number.isFinite(Number(data[key]))||Number(data[key])<0))throw Object.assign(new Error('Precio inválido'),{status:400})
      if (data.name !== undefined && !String(data.name).trim()) throw Object.assign(new Error('Nombre requerido'),{status:400})
      if (data.service_unit_label !== undefined) data.service_unit_label=data.service_unit_label.trim()
      if (data.barcode !== undefined) data.barcode=data.barcode?.trim()||null
      if (data.category_id !== undefined) data.category_id=Number(data.category_id)
      if (data.available_for_sale !== undefined) data.available_for_sale=data.available_for_sale===true||data.available_for_sale==='true'
      for (const key of ['price_wholesale','price_promotion']) if(data[key]==='')data[key]=null
      if (data.promotion_valid_until !== undefined) {data.promotion_valid_until=data.promotion_valid_until?new Date(data.promotion_valid_until):null;if(data.promotion_valid_until&&Number.isNaN(data.promotion_valid_until.getTime()))throw Object.assign(new Error('Fecha inválida'),{status:400})}
      if (payload.schedule_profile !== undefined) {
        const scope = requestScope(req)
        const product = await withAgendaTransaction(prismaTransaction, scope.companyId, async tx => {
          const product = await tx.product.update({where:{id},data})
          await saveServiceProfile(tx, scope, id, payload.schedule_profile)
          return product
        })
        return res.json(product)
      }
      return res.json(await prisma.product.update({where:{id},data}))
    }
    const branchId = requireBranch(req)

    // Preparar payload seguro: normalizar campos y validar
    const safePayload = {}
    
    // Copiar solo los campos permitidos y necesarios
    const allowedFields = [
      'name',
      'brand',
      'size',
      'stock',
      'min_stock',
      'price',
      'cost',
      'price_wholesale',
      'price_promotion',
      'promotion_valid_until',
      'barcode',
      'description',
      'image_url',
      'category_id',
      'supplier_id',
      'status_id',
      'available_for_sale',
      'tracks_expiry',
      'kind',
    ]
    for (const field of allowedFields) {
      if (payload[field] !== undefined) {
        safePayload[field] = payload[field]
      }
    }

    if (safePayload.tracks_expiry !== undefined) {
      safePayload.tracks_expiry = safePayload.tracks_expiry === true || safePayload.tracks_expiry === 'true'
    }

    if (safePayload.kind !== undefined) {
      safePayload.kind = parseKind(safePayload.kind)
      if (safePayload.kind === 'KIT' && !current.stock_assembled) {
        safePayload.stock = 0
        const bomCount = await prisma.productBomLine.count({ where: { kit_product_id: id } })
        if (bomCount === 0) {
          return res.status(400).json({
            message: 'Un kit debe tener al menos un componente. Configúralos con PUT /api/products/:id/bom antes de marcar kind=KIT.',
          })
        }
      }
    }

    if (!current.stock_assembled && (safePayload.kind === 'KIT' || current.kind === 'KIT')) {
      safePayload.stock = 0
    }

    // Opcionales: mayoreo / promoción (null borra en BD)
    for (const decField of ['price_wholesale', 'price_promotion']) {
      if (safePayload[decField] === undefined) continue
      if (safePayload[decField] === null || safePayload[decField] === '') {
        safePayload[decField] = null
        continue
      }
      const n = Number(safePayload[decField])
      if (!Number.isFinite(n) || n < 0) {
        return res.status(400).json({ message: `${decField} debe ser un número válido >= 0` })
      }
      safePayload[decField] = n
    }

    if (safePayload.promotion_valid_until !== undefined) {
      if (safePayload.promotion_valid_until === null || safePayload.promotion_valid_until === '') {
        safePayload.promotion_valid_until = null
      } else {
        const d = new Date(safePayload.promotion_valid_until)
        if (Number.isNaN(d.getTime())) {
          return res.status(400).json({ message: 'promotion_valid_until no es una fecha válida' })
        }
        safePayload.promotion_valid_until = d
      }
    }

    // Remover image_url si está vacío
    if (safePayload.image_url === '' || safePayload.image_url === null) {
      delete safePayload.image_url
    }

    // Validar y normalizar category_id
    if (safePayload.category_id !== undefined) {
      safePayload.category_id = Number(safePayload.category_id)
      if (Number.isNaN(safePayload.category_id)) {
        return res.status(400).json({ message: 'category_id debe ser un número válido' })
      }
    }

    // Validar y normalizar status_id
    if (safePayload.category_id !== undefined && !await prisma.productCategory.findFirst({where:{id:safePayload.category_id,company_id:req.companyId}})) return res.status(400).json({message:'Categoría no encontrada en esta empresa'})
    if (safePayload.status_id !== undefined) {
      safePayload.status_id = Number(safePayload.status_id)
      if (Number.isNaN(safePayload.status_id)) {
        return res.status(400).json({ message: 'status_id debe ser un número válido' })
      }
    }

    if (safePayload.available_for_sale !== undefined) {
      safePayload.available_for_sale = Boolean(safePayload.available_for_sale)
    }

    // Validar y normalizar supplier_id: debe ser un UUID válido
    if (safePayload.supplier_id !== undefined) {
      const supplierId = String(safePayload.supplier_id).trim()
      // Validar formato UUID básico (8-4-4-4-12 caracteres hex)
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      if (!uuidRegex.test(supplierId)) {
        // Si no es un UUID válido, intentar buscar el proveedor por nombre
        const supplier = await prisma.supplier.findFirst({
          where: {
            name: { equals: supplierId, mode: 'insensitive' },
            deleted: false,
            company_id: req.companyId
          }
        })
        if (supplier) {
          safePayload.supplier_id = supplier.id
        } else {
          return res.status(400).json({ message: `Proveedor no encontrado: ${supplierId}. Debe ser un UUID válido o el nombre de un proveedor existente.` })
        }
      } else {
        safePayload.supplier_id = supplierId
      }
    }

    if (safePayload.supplier_id !== undefined && !await prisma.supplier.findFirst({where:{id:safePayload.supplier_id,company_id:req.companyId,deleted:false}})) return res.status(400).json({message:'Proveedor no encontrado en esta empresa'})
    // stock y min_stock del formulario aplican a LA SUCURSAL activa, no al espejo global
    const branchStockValue = safePayload.stock !== undefined ? Number(safePayload.stock) : undefined
    const branchMinValue = safePayload.min_stock !== undefined ? Number(safePayload.min_stock) : undefined
    delete safePayload.stock
    // min_stock del producto se mantiene como default para sucursales nuevas
    if (branchMinValue !== undefined) safePayload.min_stock = branchMinValue

    let updated
    let branchRow = null
    try {
      const out = await prismaTransaction.$transaction(async (tx) => {
        const prod = await tx.product.update({ where: { id }, data: safePayload })
        const row = (branchStockValue !== undefined || branchMinValue !== undefined)
          ? await setBranchStock(tx, id, branchId, { stock: branchStockValue, minStock: branchMinValue }, { userId: req.user?.sub || null })
          : null
        return { prod, row }
      })
      updated = out.prod
      branchRow = out.row
    } catch (prismaError) {
      // Si el error es porque image_url no existe en la base de datos (migración no ejecutada)
      // Remover image_url y reintentar
      if (prismaError.message && (
        prismaError.message.includes('image_url') ||
        prismaError.message.includes('Unknown argument') ||
        prismaError.message.includes('Unknown field')
      )) {
        delete safePayload.image_url
        updated = await prisma.product.update({ where: { id }, data: safePayload })
        console.warn('[products.update] image_url no disponible en la base de datos. Ejecuta la migración para habilitar imágenes de productos.')
      } else {
        throw prismaError
      }
    }

    // If stock or min_stock changed, trigger alert logic (valores de la sucursal)
    if (branchRow) {
      try {
        await ensureStockAlert(prisma, id, Number(branchRow.stock), Number(branchRow.min_stock), branchId)
      } catch (e) {
        console.error('post-update ensureStockAlert error', e.message)
      }
    }

    const [withBranch] = await overlayBranchStock([updated], req.branchId)
    res.json(withBranch || updated)
  } catch (e) { next(e) }
}

exports.remove = async (req, res, next) => {
  try {

    const owned = await prisma.product.findFirst({
      where: { id: req.params.id, company_id: req.companyId },
      select: { id: true, name: true },
    })
    if (!owned) return res.status(404).json({ message: 'Producto no encontrado' })

    // Archivar no puede dejar existencias huérfanas ni documentos apuntando al
    // vacío: el producto desaparece de las pantallas pero sus unidades y sus
    // reservas siguen ahí. Quitarlo de UNA sucursal ya exigía stock 0; a nivel
    // de empresa era más permisivo, que es al revés de como debería ser.
    const [conStock, reservas, enKits] = await Promise.all([
      prisma.productStock.findMany({
        where: { product_id: owned.id, stock: { not: 0 } },
        select: { stock: true, branch: { select: { name: true } } },
      }),
      prisma.stockReservation.count({ where: { product_id: owned.id, status: 'ACTIVE' } }),
      prisma.productBomLine.findMany({
        where: { component_product_id: owned.id, kit_product: { deleted: false } },
        select: { kit_product: { select: { name: true } } },
      }),
    ])

    if (conStock.length > 0) {
      const donde = conStock.map((r) => `${r.branch.name} (${r.stock})`).join(', ')
      return res.status(400).json({
        message: `"${owned.name}" todavía tiene existencias en ${donde}. Ajústalas o trasládalas antes de archivarlo.`,
        code: 'PRODUCT_HAS_STOCK',
      })
    }
    if (reservas > 0) {
      return res.status(400).json({
        message: `"${owned.name}" está comprometido en ${reservas} pedido(s) o cotización(es) sin entregar.`,
        code: 'PRODUCT_HAS_RESERVATIONS',
      })
    }
    if (enKits.length > 0) {
      const kits = [...new Set(enKits.map((k) => k.kit_product.name))].join(', ')
      return res.status(400).json({
        message: `"${owned.name}" es componente de: ${kits}. Sacalo de esos kits antes de archivarlo.`,
        code: 'PRODUCT_IN_KIT',
      })
    }

    await prisma.product.update({ where: { id: req.params.id }, data: { deleted: true, deleted_at: new Date() } })
    res.json({ ok: true })
  } catch (e) { next(e) }
}

/**
 * POST /api/products/:id/branch-stock — empieza a manejar el producto en la
 * sucursal activa: le crea su fila de stock en 0. El producto ya existía (es
 * de la empresa); esto solo dice "aquí también lo vendemos".
 * body { min_stock? }
 */
exports.addToBranch = async (req, res, next) => {
  try {
    const branchId = requireBranch(req)
    const owned = await prisma.product.findFirst({
      where: { id: req.params.id, company_id: req.companyId, deleted: false },
      select: { id: true, name: true, kind:true },
    })
    if (!owned) return res.status(404).json({ message: 'Producto no encontrado' })
    assertPhysicalItem(owned)

    const key = { product_id_branch_id: { product_id: owned.id, branch_id: branchId } }
    const existing = await prisma.productStock.findUnique({ where: key })
    if (existing) return res.json({ ok: true, already: true, branch_stock: existing })

    const minStock = Number.isFinite(Number(req.body?.min_stock)) ? Number(req.body.min_stock) : 0
    const created = await prisma.productStock.create({
      data: { product_id: owned.id, branch_id: branchId, stock: 0, min_stock: minStock },
    })
    res.status(201).json({ ok: true, branch_stock: created })
  } catch (e) { next(e) }
}

/**
 * DELETE /api/products/:id/branch-stock — deja de manejar el producto en la
 * sucursal activa. El producto es de la empresa, así que esto solo borra su
 * fila de product_stocks; en las demás sucursales sigue igual.
 */
exports.removeFromBranch = async (req, res, next) => {
  try {
    const branchId = requireBranch(req)
    const owned = await prisma.product.findFirst({
      where: { id: req.params.id, company_id: req.companyId },
      select: { id: true, kind:true },
    })
    if (!owned) return res.status(404).json({ message: 'Producto no encontrado' })
    assertPhysicalItem(owned)

    const key = { product_id_branch_id: { product_id: owned.id, branch_id: branchId } }
    const row = await prisma.productStock.findUnique({ where: key })
    if (!row) return res.status(404).json({ message: 'El producto no se maneja en esta sucursal' })
    // Borrar con existencias perdería el inventario: primero trasladarlo o ajustarlo.
    // Se exige 0 en la sucursal Y en cada una de sus ubicaciones.
    const inLocations = await branchLocationStock(prisma, owned.id, branchId)
    if (Number(row.stock) !== 0 || inLocations !== 0) {
      return res.status(400).json({ message: 'Deja el stock en 0 en esta sucursal antes de quitarlo (traslada o ajusta)' })
    }

    await clearBranchLocations(prisma, owned.id, branchId)
    await prisma.productStock.delete({ where: key })
    res.json({ ok: true })
  } catch (e) { next(e) }
}

exports.commercialHistory = async (req,res,next) => {
  try {
    const product = await prisma.product.findFirst({where:{id:req.params.id,company_id:req.companyId},select:{id:true}})
    if (!product) return res.status(404).json({message:'Artículo no encontrado'})
    const where = {product_id:product.id,sale:require('../sales/commercialState').confirmedSaleWhere({branch:{company_id:req.companyId},...branchWhere(req)})}
    const pageSize = 10
    const totalItems = await prisma.saleItem.count({where})
    const totalPages = Math.max(1,Math.ceil(totalItems/pageSize))
    const page = Math.min(totalPages,Math.max(1,Number.parseInt(req.query.page,10)||1))
    const items = await prisma.saleItem.findMany({where,take:pageSize,skip:(page-1)*pageSize,orderBy:{sale:{date:'desc'}},select:{id:true,item_name:true,item_kind:true,unit_label:true,quantity_decimals:true,qty:true,price:true,net_total:true,sale:{select:{id:true,reference:true,date:true,customer:true,status:{select:{name:true}}}}}})
    res.json({items,page,pageSize,totalItems,totalPages,nextPage:page<totalPages?page+1:null,prevPage:page>1?page-1:null})
  } catch (error) {next(error)}
}

exports.reportPdf = async (req, res, next) => {
  try {
    const serviceCatalog = req.query.catalog_type === 'services'
    if (serviceCatalog || req.query.catalog_type === 'all') await assertServicesEnabled(prisma,req.companyId)
    const branding = await getBrandingForPdf(prisma, req.companyId)
    const currencyCode = (branding.currency_code && branding.currency_code.trim()) || 'GTQ'
    const money = (v) => new Intl.NumberFormat('es-GT', { style: 'currency', currency: currencyCode }).format(Number(v || 0))
    // Se exporta LO QUE SE ESTÁ VIENDO: mismo filtro y mismo alcance que el
    // listado (sucursal, almacén, ubicación, búsqueda, categoría, proveedor).
    const scope = listScope(req)
    const where = buildProductListWhere(req, scope)
    const idsParam = req.query.ids
    if (idsParam && typeof idsParam === 'string' && idsParam.trim()) {
      // Con selección explícita manda la selección, no los filtros de pantalla.
      const ids = idsParam.split(',').map((id) => id.trim()).filter(Boolean)
      if (ids.length > 0) where.id = { in: ids }
    }

    const productRows = await prisma.product.findMany({
      where,
      include: { category: true, supplier: true, status: true },
      orderBy: { name: 'asc' },
    })
    const products = await overlayScopedStock(productRows, scope)

    // Optional columns from query (e.g. ?fields=name,category,price,stock for cotización)
    const fieldsParam = req.query.fields
    const allowedFields = ['name', 'category', 'brand', 'size', 'barcode', 'price', 'price_wholesale', 'price_promotion', 'cost', 'stock', 'min_stock', 'supplier', 'status', 'description', 'kind', 'service_unit_label', 'quantity_decimals']
    const fields = fieldsParam
      ? String(fieldsParam).split(',').map((f) => f.trim().toLowerCase()).filter((f) => allowedFields.includes(f))
      : serviceCatalog ? ['name','category','kind','service_unit_label','quantity_decimals','price','status'] : null

    // Optional: include summary block (productos registrados, unidades, valor inventario). Default true.
    const includeSummaryParam = req.query.includeSummary
    const includeSummary = includeSummaryParam === undefined || includeSummaryParam === '' ||
      (String(includeSummaryParam).toLowerCase() === 'true') || (String(includeSummaryParam) === '1')

    const getCellValue = (p, key) => {
      if (p.kind === 'SERVICE' && ['brand','size','cost','stock','min_stock','supplier'].includes(key)) return ''
      const now = new Date()
      switch (key) {
        case 'kind': return p.kind === 'SERVICE' ? 'Servicio' : p.kind === 'KIT' ? 'Kit' : 'Bien'
        case 'service_unit_label': return p.kind === 'SERVICE' ? p.service_unit_label : 'unidad'
        case 'quantity_decimals': return String(p.quantity_decimals ?? 0)
        case 'name': return p.name || '-'
        case 'category': return p.category?.name || 'Sin categoría'
        case 'brand': return p.brand || '-'
        case 'size': return p.size || '-'
        case 'barcode': return p.barcode || '-'
        case 'price': return money(p.price)
        case 'price_wholesale': {
          const v = p.price_wholesale != null ? Number(p.price_wholesale) : NaN
          return Number.isFinite(v) && v > 0 ? money(v) : '—'
        }
        case 'price_promotion': {
          const v = p.price_promotion != null ? Number(p.price_promotion) : NaN
          if (!Number.isFinite(v) || v <= 0) return '—'
          const until = p.promotion_valid_until
          if (!until) return money(v)
          const d = new Date(until)
          const ds = d.toLocaleDateString('es-GT', { day: '2-digit', month: 'short', year: 'numeric' })
          if (Number.isNaN(d.getTime())) return money(v)
          if (d < now) return `${money(v)} (vencida)`
          return `${money(v)} (hasta ${ds})`
        }
        case 'cost': return money(p.cost)
        case 'stock': return String(Number(p.stock || 0))
        case 'min_stock': return String(Number(p.min_stock || 0))
        case 'supplier': return p.supplier?.name || '-'
        case 'status': return p.kind === 'SERVICE' ? (p.available_for_sale ? 'Disponible para venta' : 'No disponible') : p.status?.name || '-'
        case 'description': return (p.description || '').toString().slice(0, 80) + ((p.description || '').length > 80 ? '...' : '')
        default: return '-'
      }
    }
    const headers = {
      kind: 'Tipo', service_unit_label: 'Unidad', quantity_decimals: 'Decimales',
      name: 'Nombre',
      category: 'Categoría',
      brand: 'Marca',
      size: 'Tamaño',
      barcode: 'Código',
      price: 'Precio lista',
      price_wholesale: 'Mayoreo',
      price_promotion: 'Promoción',
      cost: 'Costo',
      stock: 'Stock',
      min_stock: 'Mín.',
      supplier: 'Proveedor',
      status: 'Estado',
      description: 'Descripción',
    }

    // CSV: las mismas columnas y las mismas filas que el PDF, en texto plano.
    if (['csv', 'excel'].includes(String(req.query.format || '').toLowerCase())) {
      const cols = fields?.length ? fields : ['name', 'category', 'brand', 'size', 'barcode', 'cost', 'price', 'stock', 'min_stock', 'supplier', 'status']
      const { sendCsv } = require('../reports/controller')
      const alcance = await scopeLabel(req, scope)
      sendCsv(res, 'inventario', [
        'INVENTARIO',
        `Alcance,${alcance}`,
        `Generado,${new Date().toLocaleString('es-GT')}`,
        `Productos,${products.length}`,
        ...(serviceCatalog ? [] : [`Unidades,${products.filter(p => p.kind !== 'SERVICE').reduce((sum, p) => sum + Number(p.stock || 0), 0)}`]),
      ], [{
        title: 'Productos',
        columns: cols.map((c) => headers[c] || c),
        rows: products.map((p) => cols.map((c) => getCellValue(p, c))),
      }])
      return
    }

    const doc = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true })
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', 'inline; filename="productos_reporte.pdf"')
    doc.pipe(res)

    setupReportPdf(doc, { branding, title: 'Informe de Productos', metadata: [
      `Generado: ${new Date().toLocaleString('es-GT')}`,
      `Alcance: ${await scopeLabel(req, scope)}`,
      ...(fields?.length ? [`Columnas: ${fields.map(f => headers[f] || f).join(', ')}`] : []),
    ] })
    const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right

    let gridTop
    if (includeSummary) {
      // Summary cards
      const totalProductos = products.length
      const totalUnidades = products.filter(p => p.kind !== 'SERVICE').reduce((s, p) => s + Number(p.stock || 0), 0)
      const valorInventario = products.filter(p => p.kind !== 'SERVICE').reduce((s, p) => s + Number(p.stock || 0) * Number(p.cost || 0), 0)

      const cardW = (pageWidth - 24) / 3
      const cardH = 56
      const startX = doc.x
      const startY = doc.y

      const drawSummary = (x, y, title, value, color = '#0c203a') => {
        doc.roundedRect(x, y, cardW, cardH, 5).fillAndStroke('#f7f9fc', '#d8e1eb')
        doc.fillColor('#63758b').font('Helvetica').fontSize(8).text(title, x + 10, y + 8, { width: cardW - 20 })
        doc.fillColor(color).font('Helvetica-Bold').fontSize(14).text(value, x + 10, y + 26, { width: cardW - 20 })
      }

      drawSummary(startX, startY, serviceCatalog ? 'Servicios registrados' : 'Productos registrados', String(totalProductos))
      drawSummary(startX + cardW + 12, startY, serviceCatalog ? 'Disponibles para venta' : 'Unidades en inventario', String(serviceCatalog ? products.filter(p=>p.available_for_sale).length : totalUnidades))
      drawSummary(startX + (cardW + 12) * 2, startY, serviceCatalog ? 'Con cantidades fraccionadas' : `Valor del inventario (${currencyCode})`, serviceCatalog ? String(products.filter(p=>p.quantity_decimals>0).length) : money(valorInventario))

      gridTop = startY + cardH + 24
    } else {
      gridTop = doc.y
    }

    if (fields && fields.length > 0) {
      doc.y = gridTop
      const numericFields = ['price', 'price_wholesale', 'price_promotion', 'cost', 'stock', 'min_stock', 'quantity_decimals']
      drawReportTable(doc, fields.map(f => headers[f] || f), products.map(p => fields.map(f => f === 'description' ? String(p.description || '') : getCellValue(p, f))), {
        widths: fields.map(f => ['name', 'description', 'supplier', 'status', 'price_promotion'].includes(f) ? 2 : 1),
        align: fields.map(f => numericFields.includes(f) ? 'right' : 'left'),
      })
    } else {
      const gap = 12, cardWidth = (pageWidth - gap) / 2, contentWidth = cardWidth - 20
      const cards = products.map(p => {
        const details = [
          `Costo: ${money(p.cost)}`,
          ...(Number(p.price_wholesale) > 0 ? [`Mayoreo: ${money(p.price_wholesale)}`] : []),
          ...(Number(p.price_promotion) > 0 ? [`Promo: ${getCellValue(p, 'price_promotion')}`] : []),
          `Stock: ${Number(p.stock || 0)}`, `Proveedor: ${p.supplier?.name || '-'}`, `Estado: ${p.status?.name || '-'}`,
          ...(p.description ? [String(p.description)] : []),
        ]
        const lines = []
        const append = (value, size, color, bold = false) => {
          doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size)
          lines.push(...reportLines(doc, value, contentWidth).map(text => ({ text, size, color, bold, height: size + 3 })))
          lines.push({ text: '', height: 5 })
        }
        append(p.name || '-', 11, '#0c203a', true)
        append(p.category?.name || 'Sin categoría', 8, '#63758b')
        lines.push({ text: money(p.price), size: 11, color: '#ffffff', bold: true, price: true, height: 30 })
        for (const value of details) append(value, 8, '#0c203a')
        return lines
      })
      doc.y = gridTop
      for (let offset = 0; offset < cards.length; offset += 2) {
        const pair = cards.slice(offset, offset + 2), positions = pair.map(() => 0)
        const totalHeight = Math.max(...pair.map(lines => lines.reduce((sum, line) => sum + line.height, 0))) + 20
        const bottom = doc.page.height - doc.page.margins.bottom - 20
        if (totalHeight < bottom - doc.page.margins.top - 150 && doc.y + totalHeight > bottom) doc.addPage()
        while (pair.some((lines, i) => positions[i] < lines.length)) {
          ensureReportSpace(doc, 55)
          const top = doc.y, available = bottom - top - 20
          const fragments = pair.map((lines, index) => {
            let height = 0, end = positions[index]
            while (end < lines.length && height + lines[end].height <= available) height += lines[end++].height
            const fragment = { lines: lines.slice(positions[index], end), height }
            positions[index] = end
            return fragment
          })
          const height = Math.max(...fragments.map(fragment => fragment.height)) + 20
          fragments.forEach((fragment, index) => {
            if (!fragment.lines.length) return
            const x = doc.page.margins.left + index * (cardWidth + gap)
            doc.roundedRect(x, top, cardWidth, height, 5).fillAndStroke('#f7f9fc', '#d8e1eb')
            let y = top + 10
            for (const line of fragment.lines) {
              if (line.price) doc.rect(x + 10, y, contentWidth, 23).fill('#ff6f00')
              if (line.text) doc.font(line.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(line.size).fillColor(line.color)
                .text(line.text, x + (line.price ? 16 : 10), y + (line.price ? 5 : 0), { width: contentWidth - (line.price ? 12 : 0), lineBreak: false })
              y += line.height
            }
          })
          doc.y = top + height + gap
          doc.x = doc.page.margins.left
          if (pair.some((lines, i) => positions[i] < lines.length)) doc.addPage()
        }
      }
    }

    finishReportPdf(doc)
    doc.end()
  } catch (e) { next(e) }
}

// Return products that are below their minimum stock (critical)
exports.critical = async (req, res, next) => {
  try {
    const rows = await prisma.product.findMany({
      where: { deleted: false, company_id: req.companyId,kind:{not:'SERVICE'} },
      include: { category: true, supplier: true, status: true },
      orderBy: { name: 'asc' },
    })
    const products = await overlayBranchStock(rows, req.branchId)

    // filter server-side for products where stock < min_stock
    const critical = products.filter((p) => {
      if (p.kind === 'KIT' && !p.stock_assembled) return false
      const stock = Number(p.stock || 0)
      const min = Number(p.min_stock || 0)
      return stock < min
    })

    res.json(critical)
  } catch (e) { next(e) }
}

// Register incoming merchandise endpoint: body { supplier_id, items, notes?, payment_term_id?, payment_status?, paid_at?, payment_reference?, due_date? }
/**
 * GET /api/products/:id/lots
 * Lotes con existencia del producto, ordenados por caducidad (FEFO).
 */
exports.getLots = async (req, res, next) => {
  try {
    const { id } = req.params
    const product = await prisma.product.findFirst({where:{id,company_id:req.companyId},select:{id:true,kind:true,tracks_expiry:true}})
    assertPhysicalItem(product)
    const scope = req.branchId ? { branch_id: req.branchId } : { branch: { company_id: req.companyId } }
    const lots = await prisma.productLot.findMany({
      where: { product_id: id, qty_remaining: { gt: 0 }, ...scope },
      // La ubicación evita que tres lotes del mismo código parezcan duplicados.
      include: {
        location: {
          select: { id: true, code: true, warehouse: { select: { id: true, name: true } } },
        },
      },
      orderBy: [{ expiry_date: { sort: 'asc', nulls: 'last' } }, { received_at: 'asc' }],
    })

    // Reconciliación: la ficha mostraba las dos sumas por separado y el usuario
    // tenía que restarlas de cabeza para descubrir que no cuadraban.
    const stocks = await prisma.productStockLocation.findMany({
      where: {
        product_id: id,
        location: {
          warehouse: req.branchId
            ? { branch_id: req.branchId }
            : { branch: { company_id: req.companyId } },
        },
      },
      select: { stock: true },
    })
    const physical = stocks.reduce((s, r) => s + Number(r.stock || 0), 0)
    const lotted = lots.reduce((s, l) => s + Number(l.qty_remaining || 0), 0)

    res.json({
      lots,
      reconciliation: {
        physical,
        lotted,
        unlotted: physical - lotted,
        tracks_expiry: Boolean(product?.tracks_expiry),
        // Con tracks_expiry cualquier diferencia es un descuadre que hay que
        // corregir; sin él, lo no lotificado es esperado y no es un error.
        balanced: physical === lotted,
      },
    })
  } catch (e) { next(e) }
}

/**
 * PATCH /api/products/lots/:lotId
 * Corrige un lote mal ingresado: cantidad, caducidad o código.
 * La cantidad reconcilia product.stock por la diferencia (el ingreso sumó a ambos).
 * body { qty_received?, expiry_date?, lot_code? }
 */
exports.updateLot = async (req, res, next) => {
  try {
    const { lotId } = req.params
    const { qty_received, expiry_date, lot_code } = req.body || {}

    const result = await prismaTransaction.$transaction(async (tx) => {
      const lot = await tx.productLot.findUnique({
        where: { id: lotId },
        include: { product: { select: { id: true, stock: true, min_stock: true, tracks_expiry: true } } },
      })
      if (!lot) { const e = new Error('Lote no encontrado'); e.status = 404; throw e }

      const data = {}
      let expiryChanged = false

      if (qty_received !== undefined) {
        const newQty = Number(qty_received)
        if (!Number.isInteger(newQty) || newQty <= 0) {
          const e = new Error('qty_received debe ser un entero mayor a 0'); e.status = 400; throw e
        }
        const consumed = lot.qty_received - lot.qty_remaining
        if (newQty < consumed) {
          const e = new Error(`No puede recibir menos de lo ya vendido de este lote (${consumed})`); e.status = 400; throw e
        }
        const delta = newQty - lot.qty_received
        data.qty_received = newQty
        data.qty_remaining = lot.qty_remaining + delta
        if (delta !== 0) {
          // Ajusta la sucursal del lote (y el espejo global) por la diferencia
          const map = new Map([[String(lot.product_id), Math.abs(delta)]])
          const lotCtx = { reason: 'MANUAL_ADJUST', refType: 'product_lot', refId: String(lotId), userId: req.user?.sub || null }
          const [row] = delta > 0
            ? await restoreStockMap(tx, map, lot.branch_id, lotCtx)
            : await deductStockMap(tx, map, lot.branch_id, lotCtx)
          if (row) await ensureStockAlert(tx, row.id, row.stock, row.min_stock, lot.branch_id)
        }
      }

      if (expiry_date !== undefined) {
        const hasExpiry = expiry_date != null && expiry_date !== ''
        if (!hasExpiry && lot.product.tracks_expiry) {
          const e = new Error('Este producto requiere fecha de caducidad'); e.status = 400; throw e
        }
        data.expiry_date = hasExpiry ? new Date(expiry_date) : null
        expiryChanged = true
      }

      if (lot_code !== undefined) {
        data.lot_code = lot_code != null ? String(lot_code).trim().slice(0, 60) || null : null
      }

      const updated = await tx.productLot.update({ where: { id: lotId }, data })
      return { updated, expiryChanged }
    })

    if (result.expiryChanged) await syncLotExpiryAlerts(prisma, { force: true })
    res.json({ lot: result.updated })
  } catch (e) { next(e) }
}

/**
 * DELETE /api/products/lots/:lotId
 * Elimina un lote (p. ej. ingresado al producto equivocado) y revierte del stock
 * la existencia que aún atribuía al producto (qty_remaining).
 */
exports.deleteLot = async (req, res, next) => {
  try {
    const { lotId } = req.params
    await prismaTransaction.$transaction(async (tx) => {
      const lot = await tx.productLot.findUnique({
        where: { id: lotId },
        include: { product: { select: { id: true, stock: true, min_stock: true } } },
      })
      if (!lot) { const e = new Error('Lote no encontrado'); e.status = 404; throw e }

      if (lot.qty_remaining > 0) {
        const map = new Map([[String(lot.product_id), lot.qty_remaining]])
        const [row] = await deductStockMap(tx, map, lot.branch_id, {
          reason: 'MANUAL_ADJUST', refType: 'product_lot', refId: String(lotId), userId: req.user?.sub || null,
        })
        if (row) await ensureStockAlert(tx, row.id, row.stock, row.min_stock, lot.branch_id)
      }

      await tx.productLot.delete({ where: { id: lotId } })
    })

    await syncLotExpiryAlerts(prisma, { force: true })
    res.json({ ok: true })
  } catch (e) { next(e) }
}

/**
 * POST /api/products/lots/write-off
 * body { lot_ids: string[], reason? }
 * Saca del inventario lo que quede de esos lotes (lo típico: ya vencieron).
 * Descuenta de la ubicación donde estaba el lote, deja el rastro en el libro y
 * el lote en 0 — no lo borra: que se sepa que existió y que se dio de baja.
 */
exports.writeOffLots = async (req, res, next) => {
  try {
    const branchId = requireBranch(req)
    const ids = [...new Set((req.body?.lot_ids || []).filter(Boolean).map(String))]
    if (ids.length === 0) return res.status(400).json({ message: 'Indica al menos un lote' })
    const reason = req.body?.reason ? String(req.body.reason).trim().slice(0, 200) : 'Lote vencido'

    const result = await prismaTransaction.$transaction(async (tx) => {
      const lots = await tx.productLot.findMany({
        where: { id: { in: ids }, branch_id: branchId },
        select: { id: true, product_id: true, location_id: true, qty_remaining: true, lot_code: true },
      })
      if (lots.length !== ids.length) {
        const e = new Error('Uno de los lotes no es de esta sucursal'); e.status = 404; throw e
      }
      let units = 0
      for (const lot of lots) {
        if (lot.qty_remaining <= 0) continue
        const map = new Map([[String(lot.product_id), lot.qty_remaining]])
        const [row] = await deductStockMap(tx, map, branchId, {
          reason: 'MANUAL_ADJUST', refType: 'product_lot', refId: String(lot.id),
          userId: req.user?.sub || null,
          notes: `${reason} (lote ${lot.lot_code || 's/n'})`.slice(0, 300),
          // Sale del anaquel donde estaba; si el lote no tenía ubicación, del
          // reparto normal (`adjust` permite tocar las que no despachan).
          ...(lot.location_id ? { locationId: lot.location_id } : { adjust: true }),
        })
        if (row) await ensureStockAlert(tx, row.id, row.stock, row.min_stock, branchId)
        units += lot.qty_remaining
      }
      await tx.productLot.updateMany({ where: { id: { in: ids } }, data: { qty_remaining: 0 } })
      return { lots: lots.length, units }
    }, { maxWait: 10000, timeout: 20000 })

    await syncLotExpiryAlerts(prisma, { force: true })
    res.json({ ok: true, ...result })
  } catch (e) { next(e) }
}

/**
 * GET /api/products/lots/expiring?days=30&status=expiring|expired|all
 * Reporte transversal de lotes por vencer / vencidos.
 */
exports.lotsExpiring = async (req, res, next) => {
  try {
    const days = Math.min(365, Math.max(1, Number(req.query.days) || 30))
    const status = ['expiring', 'expired', 'all'].includes(req.query.status) ? req.query.status : 'all'

    // "Hoy" según la zona horaria del negocio; expiry_date es DATE (medianoche UTC)
    const tz = await getTimezone(prisma, req.companyId)
    const nowTz = DateTime.now().setZone(tz)
    const today = new Date(Date.UTC(nowTz.year, nowTz.month - 1, nowTz.day))
    const limit = new Date(today.getTime() + days * 86400000)

    // Los lotes son de una sucursal: sin este filtro el reporte mezclaba
    // sucursales (y empresas).
    const where = {
      qty_remaining: { gt: 0 },
      ...(req.branchId ? { branch_id: req.branchId } : { branch: { company_id: req.companyId } }),
    }
    if (status === 'expired') where.expiry_date = { lt: today }
    else if (status === 'expiring') where.expiry_date = { gte: today, lte: limit }
    else where.expiry_date = { lte: limit } // all: vencidos + por vencer

    const lots = await prisma.productLot.findMany({
      where,
      orderBy: { expiry_date: 'asc' },
      include: {
        product: {
          select: { id: true, name: true, brand: true, size: true, barcode: true, stock: true, image_url: true }
        },
        branch: { select: { id: true, name: true, code: true } },
        location: { select: { id: true, code: true, name: true } },
      },
    })

    // Σ qty_remaining por producto para reportar stock sin lote (stock viejo pre-lotes)
    const productIds = [...new Set(lots.map(l => l.product_id))]
    const sums = productIds.length
      ? await prisma.productLot.groupBy({
          by: ['product_id'],
          where: {
            product_id: { in: productIds },
            qty_remaining: { gt: 0 },
            ...(req.branchId ? { branch_id: req.branchId } : { branch: { company_id: req.companyId } }),
          },
          _sum: { qty_remaining: true },
        })
      : []
    const lottedByProduct = Object.fromEntries(sums.map(s => [s.product_id, s._sum.qty_remaining || 0]))

    res.json({
      days,
      status,
      lots: lots.map(l => {
        const lotted = lottedByProduct[l.product_id] || 0
        return {
          id: l.id,
          lot_code: l.lot_code,
          expiry_date: l.expiry_date,
          qty_remaining: l.qty_remaining,
          days_to_expiry: Math.round((new Date(l.expiry_date).getTime() - today.getTime()) / 86400000),
          received_at: l.received_at,
          branch: l.branch,
          location: l.location,
          product: {
            ...l.product,
            lotted,
            unlotted: Math.max(0, Number(l.product.stock) - lotted),
          },
        }
      }),
    })
  } catch (e) { next(e) }
}

/**
 * Costo promedio ponderado del producto tras recibir `qty` a `unitCost`.
 * Se calcula sobre el stock de EMPRESA (el catálogo es de empresa, y el costo
 * vive en el producto, no en la sucursal). Con stock en cero o negativo el
 * promedio no significa nada: manda el costo de lo que acaba de entrar.
 */
async function updateAverageCost(tx, product, qty, unitCost, corriente) {
  const entran = Number(qty)
  const costoNuevo = Number(unitCost)
  if (!Number.isFinite(entran) || entran <= 0) return
  if (!Number.isFinite(costoNuevo) || costoNuevo < 0) return

  // El mismo producto puede venir en dos líneas del ingreso con costos
  // distintos: se arrastra el resultado de la anterior en vez de releer.
  const key = String(product.id)
  const estado = corriente.get(key) || {
    stock: Number(product.stock || 0),
    cost: Number(product.cost || 0),
  }
  const promedio = estado.stock > 0
    ? (estado.stock * estado.cost + entran * costoNuevo) / (estado.stock + entran)
    : costoNuevo
  const redondeado = Math.round(promedio * 100) / 100
  corriente.set(key, { stock: estado.stock + entran, cost: redondeado })

  await tx.product.update({ where: { id: product.id }, data: { cost: redondeado } })
}

exports.registerIncomingMerchandise = async (req, res, next) => {
  try {
    const body = req.body || {}
    const { supplier_id, items, notes, location_id, is_initial_load } = body
    // Carga de saldo de apertura (nuevo cliente/base) vs. compra operativa:
    // mismo endpoint, distinta clasificación contable/analítica.
    const merchandiseSource = is_initial_load ? 'INITIAL' : 'PURCHASE'
    const user = req.user
    if (!user || !user.sub) {
      return res.status(401).json({ message: 'Usuario no autenticado' })
    }
    const registered_by = user.sub // User ID from JWT

    if (!supplier_id || typeof supplier_id !== 'string') {
      return res.status(400).json({ message: 'supplier_id es requerido' })
    }
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: 'items debe ser un array con al menos un producto' })
    }

    // Validate items structure
    for (const item of items) {
      if (!item.product_id || !item.quantity || item.quantity <= 0) {
        return res.status(400).json({ message: 'Cada item debe tener product_id y quantity > 0' })
      }
      if (item.unit_cost == null || Number(item.unit_cost) < 0) {
        return res.status(400).json({ message: 'Cada item debe tener unit_cost >= 0' })
      }
      // Lote/caducidad (opcionales aquí; obligatoriedad se valida contra tracks_expiry en la transacción)
      if (item.expiry_date != null && item.expiry_date !== '') {
        const d = new Date(item.expiry_date)
        if (Number.isNaN(d.getTime())) {
          return res.status(400).json({ message: 'expiry_date inválida en uno de los items' })
        }
      }
    }

    const tz = await getTimezone(prisma, req.companyId)
    const nowGt = DateTime.now().setZone(tz)
    // Empaquetado deliberado: SOLO sirve para leer año/mes/día de "hoy" en la
    // zona configurada (código de lote, vencimiento por término de pago). No
    // es un instante real — sus horas/minutos no deben guardarse como si lo
    // fueran. Para el momento real del registro, usar `now` más abajo.
    const dateAsUtcWithGtClock = new Date(Date.UTC(
      nowGt.year,
      nowGt.month - 1,
      nowGt.day,
      nowGt.hour,
      nowGt.minute,
      nowGt.second,
      nowGt.millisecond
    ))
    // Instante real del registro, en UTC de verdad — esto es lo que se guarda
    // en cualquier columna que represente "cuándo pasó esto".
    const now = new Date()

    const payment_status = body.payment_status === 'PAID' ? 'PAID' : 'PENDING'
    let payment_term_id = null
    if (body.payment_term_id != null && body.payment_term_id !== '') {
      const pid = Number(body.payment_term_id)
      if (!Number.isFinite(pid)) {
        return res.status(400).json({ message: 'payment_term_id inválido' })
      }
      payment_term_id = pid
    }

    let payment_reference = body.payment_reference != null ? String(body.payment_reference).trim() : ''
    if (payment_reference.length > 255) {
      payment_reference = payment_reference.slice(0, 255)
    }

    let due_date = null
    if (body.due_date != null && body.due_date !== '') {
      const d = new Date(body.due_date)
      if (Number.isNaN(d.getTime())) {
        return res.status(400).json({ message: 'due_date inválida' })
      }
      due_date = d
    }

    let paid_at = null
    if (payment_status === 'PAID') {
      if (body.paid_at != null && body.paid_at !== '') {
        const p = new Date(body.paid_at)
        if (Number.isNaN(p.getTime())) {
          return res.status(400).json({ message: 'paid_at inválido' })
        }
        paid_at = p
      } else {
        paid_at = now
      }
    }

    const branchId = requireBranch(req)
    const supplierWithTerms = await prisma.supplier.findFirst({
      where: { id: supplier_id, company_id: req.companyId },
      include: { supplier_payment_terms: true },
    })
    if (!supplierWithTerms || supplierWithTerms.deleted) {
      return res.status(400).json({ message: 'Proveedor no encontrado' })
    }

    const allowedTermIds = new Set(
      (supplierWithTerms.supplier_payment_terms || []).map((l) => l.payment_term_id)
    )
    if (allowedTermIds.size > 0) {
      if (payment_term_id == null) {
        return res.status(400).json({ message: 'Debe seleccionar un término de pago para este proveedor' })
      }
      if (!allowedTermIds.has(payment_term_id)) {
        return res.status(400).json({ message: 'El término de pago no corresponde a este proveedor' })
      }
    } else if (payment_term_id != null) {
      return res.status(400).json({
        message: 'Este proveedor no tiene términos de pago configurados; no envíe payment_term_id',
      })
    }

    if (!due_date && payment_term_id != null) {
      const ptRow = await prisma.paymentTerm.findUnique({ where: { id: payment_term_id } })
      const nd = ptRow?.net_days != null ? Number(ptRow.net_days) : null
      if (nd != null && Number.isFinite(nd) && nd >= 0) {
        const d = new Date(dateAsUtcWithGtClock)
        d.setUTCDate(d.getUTCDate() + Math.floor(nd))
        due_date = d
      }
    }

    // Run in transaction: create audit record, update products, create purchase logs, update supplier
    // Use prismaTransaction (DIRECT_URL) for transactions as pooled connections don't support them
    const result = await prismaTransaction.$transaction(async (tx) => {
      // Verify supplier still exists
      const supplier = await tx.supplier.findUnique({ where: { id: supplier_id } })
      if (!supplier || supplier.deleted) {
        const err = new Error('Proveedor no encontrado')
        err.status = 400
        throw err
      }

      // Verify all products exist and belong to the supplier
      // Únicos: el mismo producto puede venir en dos líneas (dos lotes, o dos
      // costos en la misma factura) y contra el crudo la cuenta nunca cuadraba.
      const productIds = [...new Set(items.map(item => item.product_id))]
      const products = await tx.product.findMany({
        where: {
          id: { in: productIds },
          deleted: false,
          company_id:req.companyId,
        }
      })

      if (products.length !== productIds.length) {
        throw new Error('Uno o más productos no encontrados')
      }

      // Verify all products belong to the supplier
      for (const product of products) {
        assertPhysicalItem(product)
        if (product.supplier_id !== supplier_id) {
          const err = new Error(`El producto ${product.name} no pertenece al proveedor seleccionado`)
          err.status = 400
          throw err
        }
        if (product.kind === 'KIT') {
          const err = new Error(
            `No se puede registrar entrada de mercancía sobre el kit "${product.name}". Registra los componentes por separado.`
          )
          err.status = 400
          throw err
        }
      }

      // Productos que controlan caducidad exigen expiry_date en su item
      for (const item of items) {
        const product = products.find(p => p.id === item.product_id)
        const hasExpiry = item.expiry_date != null && item.expiry_date !== ''
        if (product?.tracks_expiry && !hasExpiry) {
          const err = new Error(`El producto "${product.name}" controla caducidad: expiry_date es requerida`)
          err.status = 400
          throw err
        }
      }

      // Create incoming merchandise audit record
      const incomingMerchandise = await tx.incomingMerchandise.create({
        data: {
          branch_id: branchId,
          supplier_id,
          registered_by,
          date: now,
          notes: notes || null,
          source: merchandiseSource,
          payment_term_id,
          payment_status: merchandiseSource === 'PURCHASE' ? 'PENDING' : payment_status,
          paid_at: merchandiseSource === 'PURCHASE' ? null : paid_at,
          payment_reference: payment_reference || null,
          due_date,
          payment_updated_by: registered_by,
          payment_updated_at: now,
        },
      })

      // Process each item
      const updatedProducts = []
      const purchaseLogs = []
      let totalPurchaseValue = 0
      // Código compartido para todos los productos de esta entrada que no traigan su propio lot_code
      // (llegaron en la misma entrega/factura). ponytail: un solo código por llamada, no por item.
      const autoLotCode = generateLotCode(dateAsUtcWithGtClock)
      let lotsCreated = 0
      // Stock y costo que va quedando por producto dentro de esta misma entrada:
      // si el mismo producto viene en dos líneas, la segunda promedia contra lo
      // que dejó la primera y no contra el dato viejo de la base.
      const costeoCorriente = new Map()
      // Dónde se guarda lo que llega: la ubicación que eligió quien recibe, o
      // la de recepción por defecto. El lote queda en la misma.
      if (location_id) {
        const owned = await tx.stockLocation.findFirst({
          where: { id: String(location_id), active: true, warehouse: { branch_id: branchId, active: true } },
          select: { id: true },
        })
        if (!owned) {
          const e = new Error('La ubicación no pertenece a esta sucursal (o está inactiva)')
          e.status = 403
          throw e
        }
      }
      const lotLocationId = location_id
        ? String(location_id)
        : await defaultLocationId(tx, branchId, { receiving: true })

      for (const item of items) {
        const product = products.find(p => p.id === item.product_id)
        if (!product) continue

        const quantity = Number(item.quantity)
        const unitCost = Number(item.unit_cost)

        // Costo promedio ponderado, ANTES de sumar lo que entra: mezcla lo que
        // ya había al costo viejo con lo que llega al costo nuevo. Sin esto el
        // costo del producto se quedaba en el del día que se creó, y con él la
        // valuación del inventario y todos los márgenes.
        await updateAverageCost(tx, product, quantity, unitCost, costeoCorriente)

        // La mercancía entra al stock de la sucursal (y al espejo global).
        // reason sigue la misma clasificación que el resto del kardex:
        // 'INITIAL' si es carga de apertura, 'PURCHASE' si es compra real.
        const [updated] = await restoreStockMap(tx, new Map([[String(product.id), quantity]]), branchId, {
          reason: merchandiseSource, refType: 'incoming_merchandise', refId: String(incomingMerchandise.id),
          userId: registered_by, locationId: lotLocationId,
        })
        updatedProducts.push(updated)

        // Create purchase log
        const purchaseLog = await tx.purchaseLog.create({
          data: {
            product_id: product.id,
            supplier_id,
            qty: quantity,
            cost: unitCost,
            date: now,
            source: merchandiseSource,
          }
        })
        purchaseLogs.push(purchaseLog)

        // Create incoming merchandise item (audit)
        await tx.incomingMerchandiseItem.create({
          data: {
            incoming_merchandise_id: incomingMerchandise.id,
            product_id: product.id,
            quantity,
            unit_cost: unitCost,
          }
        })

        // Lote con caducidad (trazabilidad). Solo si el item trae datos de lote.
        const lotCodeInput = item.lot_code != null ? String(item.lot_code).trim().slice(0, 60) : ''
        const hasExpiry = item.expiry_date != null && item.expiry_date !== ''
        if (hasExpiry || lotCodeInput) {
          // Sin código de lote ingresado: comparte el auto-generado de esta entrada.
          const lotCode = lotCodeInput || autoLotCode
          await tx.productLot.create({
            data: {
              product_id: product.id,
              branch_id: branchId,
              location_id: lotLocationId,
              lot_code: lotCode,
              expiry_date: hasExpiry ? new Date(item.expiry_date) : null,
              qty_received: quantity,
              qty_remaining: quantity,
              unit_cost: unitCost,
              supplier_id,
              incoming_merchandise_id: incomingMerchandise.id,
              received_at: now,
            }
          })
          lotsCreated++
        }

        // Update stock alerts (valores de la sucursal)
        await ensureStockAlert(tx, product.id, updated.stock, updated.min_stock, branchId)

        totalPurchaseValue += quantity * unitCost
      }

      const settledPurchase = await require('../merchandise/payables/compatibility').settleNewPurchase(
        tx, require('../merchandise/payables/access').payableScope(req), incomingMerchandise,
        { payment_status, paid_at, payment_reference }
      )
      if (settledPurchase) Object.assign(incomingMerchandise, {
        payment_status: settledPurchase.payment_status,
        paid_at: settledPurchase.paid_at,
        payment_revision: settledPurchase.payment_revision,
      })

      // Update supplier: total_purchases (solo compras reales, no apertura) and last_order
      await tx.supplier.update({
        where: { id: supplier_id },
        data: {
          ...(merchandiseSource === 'PURCHASE' ? { total_purchases: { increment: totalPurchaseValue } } : {}),
          last_order: now,
        }
      })

      return {
        incomingMerchandise,
        updatedProducts,
        purchaseLogs,
        totalPurchaseValue,
        lotsCreated,
      }
    }, {
      maxWait: 10000, // 10 seconds
      timeout: 30000, // 30 seconds
    })

    // Si la entrada creó lotes, sincronizar alertas de vencimiento de inmediato
    // (sin esperar el throttle de 10 min del GET /alerts). Advisory: no bloquea la respuesta.
    if (result.lotsCreated > 0) {
      await syncLotExpiryAlerts(prisma, { force: true })
    }

    res.json(result)
  } catch (e) {
    next(e)
  }
}

/**
 * @swagger
 * /api/products/{id}/restore:
 *   patch:
 *     summary: Restaurar producto eliminado
 *     description: Restaura un producto que fue eliminado (soft delete)
 *     tags: [Products]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Producto restaurado
 *       404:
 *         description: Producto no encontrado
 */
exports.restore = async (req, res, next) => {
  try {
    const { id } = req.params
    const owned = await prisma.product.findFirst({ where: { id, company_id: req.companyId }, select: { id: true, kind: true } })
    if (!owned) return res.status(404).json({ message: 'Producto no encontrado' })
    if (owned.kind === 'SERVICE') await assertServicesEnabled(prisma, req.companyId)
    const restored = await prisma.product.update({
      where: { id },
      data: { deleted: false, deleted_at: null },
      include: { category: true, supplier: true, status: true }
    })
    res.json({ ok: true, product: restored })
  } catch (e) {
    if (e.code === 'P2025') {
      return res.status(404).json({ message: 'Producto no encontrado' })
    }
    next(e)
  }
}

/**
 * @swagger
 * /api/products/import-template:
 *   get:
 *     summary: Descargar plantilla de importación
 *     description: Genera un archivo Excel con la estructura para importar productos masivamente
 *     tags: [Products]
 *     produces:
 *       - application/vnd.openxmlformats-officedocument.spreadsheetml.sheet
 *     responses:
 *       200:
 *         description: Archivo Excel
 */
exports.getImportTemplate = async (req, res, next) => {
  try {
    const buffer = await generateTemplateWithCatalogs(req.companyId)
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', 'attachment; filename="plantilla_productos.xlsx"')
    res.send(buffer)
  } catch (e) {
    next(e)
  }
}

/**
 * @swagger
 * /api/products/validate-import:
 *   post:
 *     summary: Validar archivo de importación
 *     description: Parsea y valida un archivo Excel antes de importar. Retorna errores por fila.
 *     tags: [Products]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *     responses:
 *       200:
 *         description: Resultado de validación
 */
exports.validateImport = async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'No se proporcionó archivo' })
    }

    const rows = parseExcel(req.file.buffer)
    if (rows.length === 0) {
      return res.status(400).json({ message: 'El archivo está vacío o no tiene datos válidos' })
    }

    const result = await validateBulkData(rows, undefined, { companyId: req.companyId })
    res.json(result)
  } catch (e) {
    next(e)
  }
}

/**
 * @swagger
 * /api/products/bulk-import:
 *   post:
 *     summary: Importar productos masivamente
 *     description: Importa productos desde un archivo Excel ya validado
 *     tags: [Products]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *     responses:
 *       200:
 *         description: Resultado de importación
 *       400:
 *         description: Error de validación
 */
exports.bulkImport = async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'No se proporcionó archivo' })
    }

    const rows = parseExcel(req.file.buffer)
    if (rows.length === 0) {
      return res.status(400).json({ message: 'El archivo está vacío o no tiene datos válidos' })
    }

    // First validate
    const validation = await validateBulkData(rows, undefined, { companyId: req.companyId })

    if (validation.invalidRows.length > 0) {
      return res.status(400).json({
        message: `${validation.invalidRows.length} filas tienen errores`,
        ...validation
      })
    }

    // All valid, proceed to import
    const result = await bulkCreateProducts(validation.validRows, {
      companyId: req.companyId,
      branchId: requireBranch(req),
      locationId: req.body?.location_id ? String(req.body.location_id) : null,
    })

    res.json({
      ok: true,
      created: result.created,
      adopted: result.adopted,
      message: result.adopted
        ? `${result.created} producto(s) nuevo(s) y ${result.adopted} que ya estaban en el catálogo, con su existencia cargada en esta sucursal`
        : `Se importaron ${result.created} productos exitosamente`,
    })
  } catch (e) {
    next(e)
  }
}

/**
 * @swagger
 * /api/products/bulk-import-mapped:
 *   post:
 *     summary: Importar productos con campos mapeados
 *     description: Importa productos desde JSON con campos ya mapeados por el frontend
 *     tags: [Products]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               products:
 *                 type: array
 *                 items:
 *                   type: object
 *     responses:
 *       200:
 *         description: Resultado de importación
 *       400:
 *         description: Error de validación
 */
exports.bulkImportMapped = async (req, res, next) => {
  try {
    const { products, importOptions } = req.body || {}

    if (!products || !Array.isArray(products) || products.length === 0) {
      return res.status(400).json({ message: 'No se proporcionaron productos para importar' })
    }

    const validation = await validateBulkData(products, importOptions, { companyId: req.companyId })

    if (validation.invalidRows.length > 0) {
      return res.status(400).json({
        message: `${validation.invalidRows.length} productos tienen errores`,
        ...validation
      })
    }

    // All valid, proceed to import
    const result = await bulkCreateProducts(validation.validRows, {
      companyId: req.companyId,
      branchId: requireBranch(req),
      locationId: req.body?.location_id ? String(req.body.location_id) : null,
    })

    res.json({
      ok: true,
      created: result.created,
      adopted: result.adopted || 0,
      skipped: (result.skipped || 0) + validation.skippedRows.length,
      errors: result.errors || [],
      message: [
        `${result.created} producto(s) nuevo(s)`,
        result.adopted ? `${result.adopted} ya en el catálogo, con existencia cargada aquí` : null,
        result.skipped ? `${result.skipped} omitido(s)` : null,
      ].filter(Boolean).join(', ')
    })
  } catch (e) {
    next(e)
  }
}

exports.bulkImportMappedStream = async (req, res) => {
  const { products, importOptions } = req.body || {}
  if (!Array.isArray(products) || !products.length) return res.status(400).json({ message: 'No se proporcionaron productos para importar' })
  const ctx = { companyId: req.companyId, branchId: requireBranch(req), locationId: req.body?.location_id ? String(req.body.location_id) : null }
  await runImportStream(res, {
    total: products.length,
    validate: () => validateBulkData(products, importOptions, { companyId: req.companyId }),
    save: (rows, onProgress, isCancelled) => bulkCreateProducts(rows, ctx, onProgress, isCancelled),
  })
}

/**
 * @swagger
 * /api/products/validate-import-mapped:
 *   post:
 *     summary: Validar productos sin importar
 *     description: Valida productos desde JSON y retorna errores sin crear registros
 *     tags: [Products]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               products:
 *                 type: array
 *                 items:
 *                   type: object
 *     responses:
 *       200:
 *         description: Resultado de validación
 */
exports.validateImportMapped = async (req, res, next) => {
  try {
    const { products, importOptions } = req.body || {}

    if (!products || !Array.isArray(products) || products.length === 0) {
      return res.status(400).json({ message: 'No se proporcionaron productos para validar' })
    }

    const validation = await validateBulkData(products, importOptions, { companyId: req.companyId })

    res.json({
      ok: validation.invalidRows.length === 0,
      totals: validation.totals,
      validRows: validation.validRows,
      invalidRows: validation.invalidRows.map((r) => ({
        rowIndex: r.rowIndex,
        errors: r.errors,
        hints: r.hints,
      })),
      resolutionHints: validation.resolutionHints,
      skippedRows: validation.skippedRows,
      catalogs: validation.catalogs,
    })
  } catch (e) {
    next(e)
  }
}

/**
 * POST /api/products/pricing-preview
 * Precio unitario por producto según cliente/canal (misma lógica que al registrar la venta).
 */
exports.pricingPreview = async (req, res, next) => {
  try {
    const { customer_contact_id: customerContactIdRaw, sales_channel: salesChannelRaw, product_ids: productIdsRaw, price_tier: priceTierRaw } =
      req.body || {}
    const {
      resolvePriceTierForContext,
      resolveUnitPriceFromProduct,
      productSupportsPriceTier,
      parsePriceTier,
      VALID_CHANNELS,
    } = require('../../services/priceResolution')

    const schRaw = salesChannelRaw != null ? String(salesChannelRaw).toUpperCase() : 'POS'
    const salesChannel = VALID_CHANNELS.has(schRaw) ? schRaw : 'POS'
    let customerContactId = null
    if (customerContactIdRaw != null && String(customerContactIdRaw).trim() !== '') {
      customerContactId = String(customerContactIdRaw).trim()
    }

    const ids = Array.isArray(productIdsRaw)
      ? [...new Set(productIdsRaw.map((x) => String(x)).filter(Boolean))]
      : []

    const explicitTier = parsePriceTier(priceTierRaw)
    const tier = explicitTier
      ? explicitTier
      : await resolvePriceTierForContext(prisma, {
          customerContactId,
          salesChannel,
          companyId:req.companyId,
        })

    if (ids.length === 0) {
      return res.json({
        price_tier_used: tier,
        sales_channel: salesChannel,
        unit_prices: {},
        tier_unavailable: [],
      })
    }

    const products = await prisma.product.findMany({
      where: { id: { in: ids }, deleted: false, available_for_sale: true, company_id: req.companyId },
      select: {
        id: true,
        name: true,
        price: true,
        price_wholesale: true,
        price_promotion: true,
        promotion_valid_until: true,
      },
    })
    const now = new Date()
    const unit_prices = {}
    const tier_unavailable = []

    for (const p of products) {
      if (explicitTier) {
        const check = productSupportsPriceTier(p, tier, now)
        if (!check.ok) {
          tier_unavailable.push({
            product_id: String(p.id),
            name: p.name,
            reason: check.reason,
          })
          continue
        }
      }
      unit_prices[String(p.id)] = resolveUnitPriceFromProduct(p, tier, now)
    }
    res.json({ price_tier_used: tier, sales_channel: salesChannel, unit_prices, tier_unavailable })
  } catch (e) {
    next(e)
  }
}

/**
 * POST /api/products/upload-image
 * Sube una imagen de producto a Supabase Storage (bucket: productos)
 * Requiere: multipart/form-data con campo 'image'
 * Retorna: { imageUrl: string }
 */
exports.uploadImage = async (req, res, next) => {
  try {
    const file = req.file

    if (!supabase) {
      return res.status(500).json({ message: 'Supabase no configurado. Verifica SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY en .env' })
    }

    if (!file) {
      return res.status(400).json({ message: 'No se proporcionó ningún archivo' })
    }

    // Validar tipo de archivo
    if (!file.mimetype.startsWith('image/')) {
      return res.status(400).json({ message: 'Solo se permiten archivos de imagen' })
    }

    // Validar tamaño (máx 5MB)
    if (file.size > 5 * 1024 * 1024) {
      return res.status(400).json({ message: 'La imagen no debe exceder 5MB' })
    }

    // Generar nombre único para el archivo
    const fileExt = file.originalname.split('.').pop() || 'jpg'
    const fileName = `${Date.now()}-${Math.random().toString(36).slice(2)}.${fileExt}`
    const filePath = fileName

    // Validar que el buffer tenga contenido
    if (!file.buffer || file.buffer.length === 0) {
      return res.status(400).json({ message: 'El archivo está vacío o no se pudo leer correctamente' })
    }

    // Subir a Supabase Storage (bucket: productos)
    const { data: uploadData, error: uploadError } = await supabase.storage
      .from('productos')
      .upload(filePath, file.buffer, {
        cacheControl: '3600',
        upsert: false,
        contentType: file.mimetype
      })

    if (uploadError) {
      return res.status(500).json({ message: 'Error al subir la imagen: ' + uploadError.message })
    }

    if (!uploadData) {
      return res.status(500).json({ message: 'Error al subir la imagen: No se recibió confirmación' })
    }

    // Obtener URL pública
    const { data: urlData } = supabase.storage
      .from('productos')
      .getPublicUrl(filePath)

    if (!urlData || !urlData.publicUrl) {
      return res.status(500).json({ message: 'Error al obtener la URL pública de la imagen' })
    }

    res.json({
      imageUrl: urlData.publicUrl
    })
  } catch (e) { next(e) }
}
