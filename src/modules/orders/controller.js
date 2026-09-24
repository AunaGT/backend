/**
 * Copyright (c) 2026 Diego Patzán. All Rights Reserved.
 *
 * Pedidos comerciales (CommercialDocument doc_type ORDER) + reserva de stock.
 */

const { prisma, prismaTransaction } = require('../../models/prisma')
const { Prisma } = require('@prisma/client')
const crypto = require('crypto')
const { ensureStockAlertsBatch } = require('../../services/stockAlerts')
const { expandLinesToStockMap, deductStockMap } = require('../../services/bomStock')
const { consumeLotsFEFO } = require('../../services/lots')
const { dispatchedByRef } = require('../../services/stockLocations')
const { resolvePriceTierForContext, resolveUnitPriceFromProduct, VALID_CHANNELS } = require('../../services/priceResolution')
const { nextDocumentReference } = require('../../services/referenceGenerator')
const { targetBranch, branchWhere } = require('../../middlewares/tenant')
const { buildOrderDateFilter, normalizeOrderAdminDetails, resolveOrderOrderBy, resolveOrderStatuses } = require('./domain')
const { getCompanyModuleBlock } = require('../platform/service')

async function loadBranch(tx, branchId) {
  return tx.branch.findUnique({ where: { id: branchId }, select: { id: true, code: true, seq: true } })
}
const {
  appendCommercialDocSearchFilter,
} = require('../../services/commercialDocumentSearch')
const { defaultOrderValidUntil } = require('../../services/commercialDocumentSettings')
const {
  assertLinesAvailable,
  reserveForDocument,
  releaseByDocument,
  consumePartialByDocument,
} = require('../../services/stockAvailability')
const {
  isOrderFullyFulfilled,
  resolveFulfillmentLines,
} = require('../../services/commercialDocumentFulfillment')

const ORDER_DOC_TYPE = 'ORDER'

/** Transacciones con reservas/stock (Supabase puede superar 5s con round-trips). */
const ORDER_TX_OPTIONS = { maxWait: 15_000, timeout: 30_000 }

const BRANCH_SELECT = { select: { id: true, name: true, code: true } }

const ORDER_LIST_INCLUDE = {
  branch: BRANCH_SELECT,
  customerContact: { select: { id: true, name: true, tax_id: true } },
  createdBy: { select: { id: true, name: true } },
  convertedFrom: { select: { id: true, reference: true, doc_type: true } },
  documentSales: {
    select: {
      id: true,
      sale: { select: { id: true, reference: true } },
    },
    take: 1,
    orderBy: { created_at: 'desc' },
  },
  _count: { select: { lines: true, stock_reservations: true, documentSales: true } },
}

const ORDER_DETAIL_INCLUDE = {
  branch: BRANCH_SELECT,
  customerContact: {
    select: { id: true, name: true, tax_id: true, contact: true, email: true, phone: true, address: true },
  },
  createdBy: { select: { id: true, name: true, email: true } },
  convertedFrom: { select: { id: true, reference: true, doc_type: true, status: true } },
  documentSales: {
    orderBy: { created_at: 'asc' },
    include: {
      sale: {
        select: {
          id: true,
          reference: true,
          total: true,
          adjusted_total: true,
          payment_status: true,
          date: true,
          status: { select: { name: true } },
          paymentEntries: { select: { amount: true } },
        },
      },
    },
  },
  lines: {
    orderBy: { sort_order: 'asc' },
    include: {
      product: { select: { id: true, name: true, barcode: true, stock: true } },
      reservations: {
        where: { status: 'ACTIVE' },
        select: { id: true, qty: true, status: true, expires_at: true, reservation_kind: true },
      },
    },
  },
  stock_reservations: {
    where: { status: 'ACTIVE' },
    select: { id: true, product_id: true, qty: true, status: true, expires_at: true },
  },
}

const orderWhereIdOrReference = (idOrRef) => {
  if (!idOrRef) return { id: '' }
  const s = String(idOrRef).trim()
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)
  if (isUuid) return { id: s, doc_type: ORDER_DOC_TYPE }
  return { reference: s, doc_type: ORDER_DOC_TYPE }
}

async function ensurePublicToken(tx, docId) {
  const doc = await tx.commercialDocument.findUnique({
    where: { id: docId },
    select: { public_token: true },
  })
  if (doc?.public_token) return doc.public_token

  for (let attempt = 0; attempt < 5; attempt++) {
    const token = crypto.randomBytes(24).toString('hex')
    const exists = await tx.commercialDocument.findFirst({ where: { public_token: token } })
    if (exists) continue
    await tx.commercialDocument.update({ where: { id: docId }, data: { public_token: token } })
    return token
  }

  const error = new Error('No se pudo generar enlace público')
  error.status = 500
  throw error
}

function parseSalesChannel(raw) {
  const sch = raw != null ? String(raw).toUpperCase() : 'WHOLESALE'
  return VALID_CHANNELS.has(sch) ? sch : 'WHOLESALE'
}

async function validateCustomerContact(tx, customerContactId) {
  if (!customerContactId) return
  const cust = await tx.supplier.findFirst({
    where: { id: customerContactId, deleted: false, party_type: 'CUSTOMER' },
    select: { id: true },
  })
  if (!cust) {
    const err = new Error('Cliente de contacto no encontrado o no es un cliente del maestro')
    err.status = 400
    throw err
  }
}

async function resolveOrderLines(tx, items, ctx, { freezePrices = false } = {}) {
  if (!Array.isArray(items) || items.length === 0) {
    const err = new Error('Debe incluir al menos un producto')
    err.status = 400
    throw err
  }

  const productIds = []
  for (const it of items) {
    const pid = String(it.product_id)
    const q = Number(it.qty || 0)
    if (!pid || !Number.isFinite(q) || q <= 0) {
      const err = new Error('Cada línea debe incluir product_id y qty > 0')
      err.status = 400
      throw err
    }
    productIds.push(pid)
  }

  const uniqueIds = [...new Set(productIds)]
  const products = await tx.product.findMany({
    where: { id: { in: uniqueIds }, deleted: false },
    select: {
      id: true,
      name: true,
      price: true,
      price_wholesale: true,
      price_promotion: true,
      promotion_valid_until: true,
      available_for_sale: true,
    },
  })
  const prodMap = new Map(products.map((p) => [String(p.id), p]))

  for (const pid of uniqueIds) {
    const p = prodMap.get(pid)
    if (!p) {
      const err = new Error(`Producto no encontrado o eliminado: ${pid}`)
      err.status = 400
      throw err
    }
    if (!p.available_for_sale) {
      const err = new Error(`Producto no disponible para pedido: ${p.name}`)
      err.status = 400
      throw err
    }
  }

  const priceTier = await resolvePriceTierForContext(tx, ctx)
  const priceNow = new Date()
  let sortOrder = 0
  const lines = items.map((it) => {
    const p = prodMap.get(String(it.product_id))
    const qty = Number(it.qty || 0)
    const unitPrice =
      freezePrices && it.unit_price != null
        ? Number(it.unit_price)
        : it.unit_price != null && Number(it.unit_price) >= 0
          ? Number(it.unit_price)
          : resolveUnitPriceFromProduct(p, priceTier, priceNow)
    const lineTotal = Math.round(unitPrice * qty * 100) / 100
    return {
      product_id: p.id,
      qty,
      unit_price: new Prisma.Decimal(unitPrice),
      line_total: new Prisma.Decimal(lineTotal),
      sort_order: sortOrder++,
    }
  })

  const subtotal = lines.reduce((acc, l) => acc + Number(l.line_total), 0)
  return {
    lines,
    subtotal: Math.round(subtotal * 100) / 100,
    total: Math.round(subtotal * 100) / 100,
  }
}

async function requireCashSession(tx, user, explicitRegisterId, branchId) {
  let cashSessionIdForSale = null
  const isAdmin = String(user.role?.name || user.role_name || '').toLowerCase() === 'admin'
  // Caja: la explícita (POS) > la asignada al usuario > la predeterminada. Siempre de la sucursal.
  let register = null
  if (explicitRegisterId) {
    register = await tx.cashRegister.findFirst({
      where: { id: String(explicitRegisterId), active: true, branch_id: branchId },
    })
  }
  if (!register && user.sub) {
    const u = await tx.user.findUnique({
      where: { id: String(user.sub) },
      select: { cashRegister: { select: { id: true, active: true, branch_id: true } } },
    })
    if (u?.cashRegister?.active && u.cashRegister.branch_id === branchId) register = u.cashRegister
  }
  if (!register) {
    register = await tx.cashRegister.findFirst({
      where: { is_default: true, active: true, branch_id: branchId },
    })
  }
  if (!register) {
    const err = new Error('NO_CASH_REGISTER')
    err.status = 503
    throw err
  }
  const openSess = await tx.cashRegisterSession.findFirst({
    where: { cash_register_id: register.id, status: 'OPEN' },
    select: { id: true, opened_by_id: true, openedBy: { select: { name: true } } },
  })
  if (openSess) {
    // Mismo control que en sales.controller.js: el turno abierto en la caja
    // resuelta tiene que ser del vendedor actual, no de quien sea que la
    // haya dejado abierta.
    if (!isAdmin && String(openSess.opened_by_id) !== String(user.sub)) {
      const err = new Error('CASH_SESSION_OTHER_USER')
      err.status = 403
      err.openedByName = openSess.openedBy?.name || 'otro usuario'
      throw err
    }
    cashSessionIdForSale = openSess.id
  } else if (!isAdmin) {
    const err = new Error('CASH_SESSION_REQUIRED')
    err.status = 403
    throw err
  }
  return cashSessionIdForSale
}

exports.list = async (req, res, next) => {
  try {
    const {
      status,
      search,
      customer_contact_id: customerContactId,
      date_from: dateFrom,
      date_to: dateTo,
      preparation_status: preparationStatus,
      delivery_status: deliveryStatus,
      sort = 'created_desc',
    } = req.query || {}
    const page = Math.max(1, Number(req.query.page ?? 1))
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize ?? 25)))
    const searchTerm = String(search || '').trim()

    const where = { doc_type: ORDER_DOC_TYPE, ...branchWhere(req) }
    // Filtrar por una sucursal solo tiene sentido en la vista consolidada, y solo
    // dentro de las que esa vista ya alcanza: un id suelto ensancharía el alcance
    // a otra empresa.
    const wantedBranch = req.query.branch_id ? String(req.query.branch_id) : null
    if (!req.branchId && wantedBranch && (req.branchIds || []).includes(wantedBranch)) {
      where.branch_id = wantedBranch
    }
    let searchMeta = null
    if (searchTerm) {
      const meta = appendCommercialDocSearchFilter(where, searchTerm)
      searchMeta = meta
      if (meta.kind === 'tooShort') {
        return res.json({
          items: [],
          page: 1,
          pageSize,
          totalPages: 0,
          totalItems: 0,
          nextPage: null,
          prevPage: null,
          searchMeta: meta,
        })
      }
    }

    if (customerContactId) {
      const id = String(customerContactId)
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
        return res.status(400).json({ message: 'Cliente inválido' })
      }
      where.customer_contact_id = id
    }
    const createdAt = buildOrderDateFilter(dateFrom, dateTo)
    if (createdAt) where.created_at = createdAt

    const summaryWhere = { ...where }
    const statuses = resolveOrderStatuses({
      status,
      preparation: preparationStatus,
      delivery: deliveryStatus,
    })
    if (statuses) where.status = { in: statuses }

    const [totalItems, statusCounts] = await Promise.all([
      prisma.commercialDocument.count({ where }),
      prisma.commercialDocument.groupBy({ by: ['status'], where: summaryWhere, _count: { _all: true } }),
    ])
    const totalPages = Math.max(1, Math.ceil(totalItems / pageSize))
    const safePage = Math.min(page, totalPages)

    const items = await prisma.commercialDocument.findMany({
      where,
      include: ORDER_LIST_INCLUDE,
      orderBy: resolveOrderOrderBy(String(sort)),
      skip: (safePage - 1) * pageSize,
      take: pageSize,
    })

    res.json({
      items,
      page: safePage,
      pageSize,
      totalPages,
      totalItems,
      nextPage: safePage < totalPages ? safePage + 1 : null,
      prevPage: safePage > 1 ? safePage - 1 : null,
      summary: statusCounts.reduce((acc, row) => {
        acc[row.status] = row._count._all
        return acc
      }, {}),
      ...(searchMeta ? { searchMeta } : {}),
    })
  } catch (e) {
    next(e)
  }
}

exports.getById = async (req, res, next) => {
  try {
    const where = {
      ...orderWhereIdOrReference(req.params.id),
      branch: { company_id: req.companyId },
    }
    const doc = await prisma.commercialDocument.findFirst({
      where,
      include: ORDER_DETAIL_INCLUDE,
    })
    if (!doc) return res.status(404).json({ message: 'Pedido no encontrado' })
    res.json(doc)
  } catch (e) {
    next(e)
  }
}

exports.updateAdminDetails = async (req, res, next) => {
  try {
    const where = { ...orderWhereIdOrReference(req.params.id), branch: { company_id: req.companyId } }
    const order = await prisma.commercialDocument.findFirst({ where, select: { id: true } })
    if (!order) return res.status(404).json({ message: 'Pedido no encontrado' })

    const data = normalizeOrderAdminDetails(req.body)
    if (!Object.keys(data).length) return res.status(400).json({ message: 'No hay cambios válidos' })

    const updated = await prisma.commercialDocument.update({
      where: { id: order.id },
      data,
      include: ORDER_DETAIL_INCLUDE,
    })
    res.json(updated)
  } catch (error) {
    next(error)
  }
}

exports.getShareLink = async (req, res, next) => {
  try {
    const order = await prisma.commercialDocument.findFirst({
      where: {
        ...orderWhereIdOrReference(req.params.id),
        branch: { company_id: req.companyId },
      },
      select: { id: true },
    })
    if (!order) return res.status(404).json({ message: 'Pedido no encontrado' })

    const token = await prisma.$transaction((tx) => ensurePublicToken(tx, order.id))
    const base = String(process.env.PUBLIC_APP_URL || process.env.FRONTEND_URL || '').replace(/\/$/, '')
    const path = `/p/${token}`
    res.json({ public_token: token, public_url: base ? `${base}${path}` : path })
  } catch (error) {
    next(error)
  }
}

exports.getPublicByToken = async (req, res, next) => {
  try {
    const token = String(req.params.token || '').trim()
    if (!token) return res.status(400).json({ message: 'Token requerido' })

    const order = await prisma.commercialDocument.findFirst({
      where: { public_token: token, doc_type: ORDER_DOC_TYPE },
      select: {
        reference: true,
        status: true,
        created_at: true,
        updated_at: true,
        confirmed_at: true,
        valid_until: true,
        customer: true,
        customer_nit: true,
        is_final_consumer: true,
        sales_channel: true,
        subtotal: true,
        discount_total: true,
        total: true,
        notes: true,
        branch: { select: { company_id: true, name: true, code: true } },
        customerContact: {
          select: { name: true, contact: true, email: true, phone: true, address: true },
        },
        lines: {
          orderBy: { sort_order: 'asc' },
          select: {
            qty: true,
            qty_fulfilled: true,
            unit_price: true,
            line_total: true,
            product: { select: { name: true, barcode: true } },
          },
        },
        documentSales: {
          orderBy: { created_at: 'asc' },
          select: {
            sale: {
              select: {
                reference: true,
                total: true,
                date: true,
                status: { select: { name: true } },
              },
            },
          },
        },
      },
    })
    if (!order) return res.status(404).json({ message: 'Pedido no encontrado' })

    const moduleBlock = await getCompanyModuleBlock(order.branch.company_id, 'orders')
    if (moduleBlock) return res.status(403).json(moduleBlock)

    const companyRows = await prisma.systemSetting.findMany({
      where: {
        key: { in: ['company_name', 'company_logo_url'] },
        company_id: order.branch.company_id,
      },
    })
    const company = Object.fromEntries(companyRows.map((row) => [row.key, row.value]))

    res.json({
      reference: order.reference,
      status: order.status,
      created_at: order.created_at,
      updated_at: order.updated_at,
      confirmed_at: order.confirmed_at,
      valid_until: order.valid_until,
      customer: order.customer,
      customer_nit: order.is_final_consumer ? null : order.customer_nit,
      is_final_consumer: order.is_final_consumer,
      customer_contact: order.customerContact,
      sales_channel: order.sales_channel,
      subtotal: order.subtotal,
      discount_total: order.discount_total,
      total: order.total,
      notes: order.notes,
      branch: order.branch ? { name: order.branch.name, code: order.branch.code } : null,
      company_name: company.company_name || 'Auna',
      company_logo_url: String(company.company_logo_url || '').trim(),
      lines: order.lines.map((line) => ({
        product_name: line.product?.name || null,
        barcode: line.product?.barcode || null,
        qty: line.qty,
        qty_fulfilled: line.qty_fulfilled || 0,
        unit_price: line.unit_price,
        line_total: line.line_total,
      })),
      sales: order.documentSales.flatMap(({ sale }) => sale ? [{
        reference: sale.reference,
        total: sale.total,
        date: sale.date,
        status: sale.status?.name || null,
      }] : []),
    })
  } catch (error) {
    next(error)
  }
}

exports.create = async (req, res, next) => {
  try {
    const user = req.user
    if (!user?.sub) return res.status(401).json({ message: 'Usuario no autenticado' })

    const {
      items,
      customer,
      customer_nit,
      is_final_consumer = true,
      customer_contact_id: customerContactIdRaw,
      sales_channel: salesChannelRaw,
      notes,
      valid_until: validUntilRaw,
    } = req.body || {}

    const salesChannel = parseSalesChannel(salesChannelRaw)
    let customerContactId = null
    if (customerContactIdRaw != null && String(customerContactIdRaw).trim() !== '') {
      customerContactId = String(customerContactIdRaw).trim()
    }

    const branchId = targetBranch(req, req.body?.branch_id)

    const created = await prismaTransaction.$transaction(async (tx) => {
      await validateCustomerContact(tx, customerContactId)
      const { lines, subtotal, total } = await resolveOrderLines(tx, items, {
        customerContactId,
        salesChannel,
      })

      let validUntil = validUntilRaw ? new Date(validUntilRaw) : await defaultOrderValidUntil(tx)
      if (Number.isNaN(validUntil.getTime())) {
        const err = new Error('valid_until inválido')
        err.status = 400
        throw err
      }

      const branch = await loadBranch(tx, branchId)
      const reference = await nextDocumentReference(tx, 'P', branch)

      return tx.commercialDocument.create({
        data: {
          branch_id: branchId,
          reference,
          doc_type: ORDER_DOC_TYPE,
          status: 'DRAFT',
          valid_until: validUntil,
          customer: customer != null ? String(customer).trim() || null : null,
          customer_nit: customer_nit != null ? String(customer_nit).trim() || null : null,
          is_final_consumer: Boolean(is_final_consumer),
          customer_contact_id: customerContactId,
          sales_channel: salesChannel,
          subtotal: new Prisma.Decimal(subtotal),
          discount_total: new Prisma.Decimal(0),
          total: new Prisma.Decimal(total),
          notes: notes != null ? String(notes).trim() || null : null,
          created_by: user.sub,
          lines: { create: lines },
        },
        include: ORDER_DETAIL_INCLUDE,
      })
    })

    res.status(201).json(created)
  } catch (e) {
    next(e)
  }
}

exports.update = async (req, res, next) => {
  try {
    const user = req.user
    if (!user?.sub) return res.status(401).json({ message: 'Usuario no autenticado' })

    const where = { ...orderWhereIdOrReference(req.params.id), branch: { company_id: req.companyId } }
    const existing = await prisma.commercialDocument.findFirst({ where })
    if (!existing) return res.status(404).json({ message: 'Pedido no encontrado' })
    if (existing.status !== 'DRAFT') {
      return res.status(400).json({ message: 'Solo se pueden editar pedidos en borrador' })
    }

    const {
      items,
      customer,
      customer_nit,
      is_final_consumer,
      customer_contact_id: customerContactIdRaw,
      sales_channel: salesChannelRaw,
      notes,
      valid_until: validUntilRaw,
    } = req.body || {}

    const salesChannel = parseSalesChannel(salesChannelRaw ?? existing.sales_channel)
    let customerContactId = existing.customer_contact_id
    if (customerContactIdRaw !== undefined) {
      customerContactId =
        customerContactIdRaw != null && String(customerContactIdRaw).trim() !== ''
          ? String(customerContactIdRaw).trim()
          : null
    }

    const updated = await prismaTransaction.$transaction(async (tx) => {
      await validateCustomerContact(tx, customerContactId)
      const { lines, subtotal, total } = await resolveOrderLines(tx, items, {
        customerContactId,
        salesChannel,
      })

      let validUntil = existing.valid_until
      if (validUntilRaw !== undefined) {
        validUntil = validUntilRaw ? new Date(validUntilRaw) : await defaultOrderValidUntil(tx)
        if (Number.isNaN(validUntil.getTime())) {
          const err = new Error('valid_until inválido')
          err.status = 400
          throw err
        }
      }

      await tx.commercialDocumentLine.deleteMany({ where: { document_id: existing.id } })

      return tx.commercialDocument.update({
        where: { id: existing.id },
        data: {
          customer: customer !== undefined ? (customer != null ? String(customer).trim() || null : null) : undefined,
          customer_nit:
            customer_nit !== undefined
              ? customer_nit != null
                ? String(customer_nit).trim() || null
                : null
              : undefined,
          is_final_consumer: is_final_consumer !== undefined ? Boolean(is_final_consumer) : undefined,
          customer_contact_id: customerContactId,
          sales_channel: salesChannel,
          subtotal: new Prisma.Decimal(subtotal),
          total: new Prisma.Decimal(total),
          notes: notes !== undefined ? (notes != null ? String(notes).trim() || null : null) : undefined,
          valid_until: validUntil,
          lines: { create: lines },
        },
        include: ORDER_DETAIL_INCLUDE,
      })
    })

    res.json(updated)
  } catch (e) {
    next(e)
  }
}

// PUT /api/orders/:id/branch — reasigna un pedido en borrador a otra sucursal
exports.changeBranch = async (req, res, next) => {
  try {
    // Solo se mueve un pedido de la sucursal en la que se está parado: con el
    // alcance de empresa cualquiera podría jalarse los pedidos de otra sucursal.
    const where = { ...orderWhereIdOrReference(req.params.id), ...branchWhere(req) }
    const order = await prisma.commercialDocument.findFirst({ where })
    if (!order) return res.status(404).json({ message: 'Pedido no encontrado' })
    if (order.status !== 'DRAFT') {
      return res.status(400).json({ message: 'Solo se puede cambiar de sucursal un pedido en borrador' })
    }

    const branchId = targetBranch(req, req.body?.branch_id)
    if (branchId === order.branch_id) {
      const same = await prisma.commercialDocument.findFirst({ where, include: ORDER_DETAIL_INCLUDE })
      return res.json(same)
    }

    const updated = await prismaTransaction.$transaction(async (tx) => {
      const branch = await loadBranch(tx, branchId)
      // El correlativo es por sucursal (@@unique([branch_id, reference])): al mudarse
      // toma un número de la serie nueva, arrastrar el viejo rompería la numeración.
      const reference = await nextDocumentReference(tx, 'P', branch)
      return tx.commercialDocument.update({
        where: { id: order.id },
        data: { branch_id: branchId, reference },
        include: ORDER_DETAIL_INCLUDE,
      })
    }, ORDER_TX_OPTIONS)

    res.json(updated)
  } catch (e) {
    next(e)
  }
}

exports.confirm = async (req, res, next) => {
  try {
    const user = req.user
    if (!user?.sub) return res.status(401).json({ message: 'Usuario no autenticado' })

    const where = { ...orderWhereIdOrReference(req.params.id), branch: { company_id: req.companyId } }
    const order = await prisma.commercialDocument.findFirst({
      where,
      include: { lines: { orderBy: { sort_order: 'asc' } } },
    })
    if (!order) return res.status(404).json({ message: 'Pedido no encontrado' })
    if (order.status !== 'DRAFT') {
      return res.status(400).json({ message: 'Solo se pueden confirmar pedidos en borrador' })
    }
    if (!order.lines?.length) {
      return res.status(400).json({ message: 'El pedido debe tener al menos una línea' })
    }

    const lineRows = order.lines

    await prismaTransaction.$transaction(async (tx) => {
      await assertLinesAvailable(
        tx,
        lineRows.map((l) => ({ product_id: l.product_id, qty: l.qty })),
        { branchId: order.branch_id }
      )

      const now = new Date()
      await tx.commercialDocument.update({
        where: { id: order.id },
        data: {
          status: 'CONFIRMED',
          confirmed_at: now,
        },
      })

      await reserveForDocument(tx, {
        documentId: order.id,
        documentLines: lineRows,
        expiresAt: order.valid_until,
        createdBy: user.sub,
        branchId: order.branch_id,
      })
    }, ORDER_TX_OPTIONS)

    const updated = await prisma.commercialDocument.findFirst({
      where: { id: order.id },
      include: ORDER_DETAIL_INCLUDE,
    })

    res.json(updated)
  } catch (e) {
    next(e)
  }
}

exports.cancel = async (req, res, next) => {
  try {
    const where = { ...orderWhereIdOrReference(req.params.id), branch: { company_id: req.companyId } }
    const order = await prisma.commercialDocument.findFirst({ where })
    if (!order) return res.status(404).json({ message: 'Pedido no encontrado' })

    if (!['DRAFT', 'CONFIRMED', 'PARTIALLY_FULFILLED'].includes(order.status)) {
      return res.status(400).json({ message: `No se puede cancelar un pedido en estado ${order.status}` })
    }
    const salesCount = await prisma.commercialDocumentSale.count({ where: { document_id: order.id } })
    if (salesCount > 0) {
      return res.status(400).json({ message: 'No se puede cancelar un pedido con ventas registradas' })
    }

    const updated = await prismaTransaction.$transaction(async (tx) => {
      if (order.status === 'CONFIRMED' || order.status === 'PARTIALLY_FULFILLED') {
        await releaseByDocument(tx, order.id, { status: 'RELEASED' })
      }
      return tx.commercialDocument.update({
        where: { id: order.id },
        data: { status: 'CANCELLED' },
        include: ORDER_DETAIL_INCLUDE,
      })
    }, ORDER_TX_OPTIONS)

    res.json(updated)
  } catch (e) {
    next(e)
  }
}

exports.convertToSale = async (req, res, next) => {
  try {
    const user = req.user
    if (!user?.sub) return res.status(401).json({ message: 'Usuario no autenticado' })

    const { payment_method_id: paymentMethodIdRaw, amount_received, change: changeRaw, lines: linesRaw, cash_register_id: cashRegisterId } =
      req.body || {}
    const paymentMethodId = Number(paymentMethodIdRaw)
    if (!Number.isFinite(paymentMethodId) || paymentMethodId <= 0) {
      return res.status(400).json({ message: 'payment_method_id requerido' })
    }

    const where = { ...orderWhereIdOrReference(req.params.id), branch: { company_id: req.companyId } }
    const order = await prisma.commercialDocument.findFirst({
      where,
      include: { lines: { orderBy: { sort_order: 'asc' } } },
    })
    if (!order) return res.status(404).json({ message: 'Pedido no encontrado' })
    if (!['CONFIRMED', 'PARTIALLY_FULFILLED'].includes(order.status)) {
      return res.status(400).json({ message: 'Solo pedidos confirmados o parciales pueden convertirse en venta' })
    }
    // La entrega ocurre en la sucursal del pedido: ahí están la reserva y el stock
    if (req.branchId !== order.branch_id) {
      return res.status(400).json({ message: 'El pedido pertenece a otra sucursal; cambia de sucursal para entregarlo' })
    }

    let fulfillments
    try {
      fulfillments = resolveFulfillmentLines(order.lines, linesRaw)
    } catch (e) {
      return res.status(e.status || 400).json({ message: e.message })
    }
    if (fulfillments.length === 0) {
      return res.status(400).json({ message: 'No hay líneas pendientes por entregar' })
    }

    const result = await prismaTransaction.$transaction(async (tx) => {
      const cashSessionIdForSale = await requireCashSession(tx, user, cashRegisterId, order.branch_id)

      const paymentMethod = await tx.paymentMethod.findUnique({ where: { id: paymentMethodId } })
      if (!paymentMethod) {
        const err = new Error('Método de pago no encontrado')
        err.status = 400
        throw err
      }
      // Este flujo aún no crea la cuenta por cobrar ni valida límite/vencimiento.
      // Bloquear es más seguro que registrar una venta a crédito como pagada.
      if (paymentMethod.is_credit) {
        const err = new Error('Los pedidos al crédito deben cobrarse desde una venta directa por ahora')
        err.status = 400
        err.code = 'ORDER_CREDIT_NOT_SUPPORTED'
        throw err
      }

      await assertLinesAvailable(
        tx,
        fulfillments.map(({ line, qty }) => ({ product_id: line.product_id, qty })),
        { excludeDocumentId: order.id, branchId: order.branch_id }
      )

      const completadaStatus = await tx.saleStatus.findFirst({ where: { name: 'Completada' } })
      if (!completadaStatus) throw new Error("No existe el estado 'Completada'")

      // Instante real de la venta, en UTC de verdad — mismo arreglo que en
      // sales.controller.js (antes reetiquetaba la hora de Guatemala como UTC).
      const saleDate = new Date()

      const totalItems = fulfillments.reduce((acc, f) => acc + f.qty, 0)
      const subtotal = Math.round(
        fulfillments.reduce((acc, f) => acc + Number(f.line.unit_price) * f.qty, 0) * 100
      ) / 100
      const total = subtotal
      const branch = await loadBranch(tx, order.branch_id)
      const saleRef = await nextDocumentReference(tx, 'V', branch)

      const sale = await tx.sale.create({
        data: {
          branch_id: order.branch_id,
          customer: order.customer,
          customer_nit: order.customer_nit,
          is_final_consumer: order.is_final_consumer,
          payment_method_id: paymentMethodId,
          amount_received: amount_received != null ? Number(amount_received) : null,
          change: changeRaw != null ? Number(changeRaw) : null,
          customer_contact_id: order.customer_contact_id || undefined,
          sales_channel: order.sales_channel,
          reference: saleRef,
          date: saleDate,
          sold_at: saleDate,
          items: totalItems,
          subtotal,
          discount_total: 0,
          total,
          total_returned: 0,
          adjusted_total: total,
          status_id: completadaStatus.id,
          created_by: user.sub,
          cash_register_session_id: cashSessionIdForSale || undefined,
        },
      })

      // Mismo criterio que en el punto de venta: el costo se congela al vender.
      const costos = new Map(
        (await tx.product.findMany({
          where: { id: { in: [...new Set(fulfillments.map((f) => f.line.product_id))] } },
          select: { id: true, cost: true },
        })).map((p) => [String(p.id), p.cost])
      )
      await tx.saleItem.createMany({
        data: fulfillments.map(({ line, qty }) => ({
          sale_id: sale.id,
          product_id: line.product_id,
          price: line.unit_price,
          unit_cost: costos.get(String(line.product_id)) ?? null,
          qty,
        })),
      })

      const stockMap = await expandLinesToStockMap(
        tx,
        fulfillments.map(({ line, qty }) => ({ product_id: line.product_id, qty }))
      )
      const orderStockCtx = {
        reason: 'ORDER_FULFILL', refType: 'commercial_document', refId: String(order.id), userId: user.sub,
        groupId: require('crypto').randomUUID(),
      }
      const updatedProducts = await deductStockMap(tx, stockMap, order.branch_id, orderStockCtx)
      // Advisory: descuenta lotes por caducidad, dentro de la ubicación que despachó.
      await consumeLotsFEFO(tx, stockMap, order.branch_id, await dispatchedByRef(tx, { groupId: orderStockCtx.groupId }))
      await ensureStockAlertsBatch(tx, updatedProducts, order.branch_id)

      await consumePartialByDocument(
        tx,
        order.id,
        fulfillments.map((f) => ({ line_id: f.line_id, qty: f.qty }))
      )

      await tx.commercialDocumentSale.create({
        data: { document_id: order.id, sale_id: sale.id },
      })

      const refreshedLines = await tx.commercialDocumentLine.findMany({
        where: { document_id: order.id },
        orderBy: { sort_order: 'asc' },
      })
      const nextStatus = isOrderFullyFulfilled(refreshedLines) ? 'FULFILLED' : 'PARTIALLY_FULFILLED'

      const fulfilled = await tx.commercialDocument.update({
        where: { id: order.id },
        data: { status: nextStatus },
        include: ORDER_DETAIL_INCLUDE,
      })

      const saleDetail = await tx.sale.findUnique({
        where: { id: sale.id },
        include: {
          payment_method: true,
          status: true,
          sale_items: {
            include: {
              product: { select: { id: true, name: true, barcode: true } },
            },
          },
          createdBy: { select: { id: true, name: true, email: true } },
        },
      })

      return { order: fulfilled, sale: saleDetail }
    }, ORDER_TX_OPTIONS)

    res.status(201).json(result)
  } catch (e) {
    if (e.message === 'CASH_SESSION_REQUIRED') {
      return res.status(403).json({ message: 'Debe abrir la caja antes de registrar la venta' })
    }
    if (e.message === 'CASH_SESSION_OTHER_USER') {
      return res.status(403).json({
        code: 'CASH_SESSION_OTHER_USER',
        message: `Esta caja ya tiene un turno abierto por ${e.openedByName}. Debe cerrar ese turno o utilizar una caja asignada.`
      })
    }
    if (e.message === 'NO_CASH_REGISTER') {
      return res.status(503).json({ message: 'No hay caja registradora configurada' })
    }
    next(e)
  }
}
