/**
 * Copyright (c) 2026 Diego Patzán. All Rights Reserved.
 *
 * Cotizaciones comerciales (CommercialDocument doc_type QUOTE).
 */

const { prisma, prismaTransaction } = require('../models/prisma')
const { Prisma } = require('@prisma/client')
const crypto = require('crypto')
const {
  resolvePriceTierForContext,
  resolveUnitPriceFromProduct,
  productSupportsPriceTier,
  parsePriceTier,
  VALID_CHANNELS,
} = require('../services/priceResolution')
const { nextDocumentReference } = require('../services/referenceGenerator')
const { targetBranch, branchWhere } = require('../middlewares/tenant')
const { getCompanyModuleBlock } = require('../modules/quotes/access')

async function loadBranch(tx, branchId) {
  return tx.branch.findUnique({ where: { id: branchId }, select: { id: true, code: true, seq: true } })
}
const {
  appendCommercialDocSearchFilter,
} = require('../services/commercialDocumentSearch')
const { defaultQuoteValidUntil, defaultQuoteSoftHoldExpiresAt } = require('../services/commercialDocumentSettings')
const {
  assertLinesAvailable,
  reserveForDocument,
  releaseByDocument,
} = require('../services/stockAvailability')

const QUOTE_DOC_TYPE = 'QUOTE'
const ORDER_DOC_TYPE = 'ORDER'

const BRANCH_SELECT = { select: { id: true, name: true, code: true } }

const QUOTE_LIST_INCLUDE = {
  branch: BRANCH_SELECT,
  customerContact: { select: { id: true, name: true, tax_id: true } },
  createdBy: { select: { id: true, name: true } },
  _count: { select: { lines: true } },
}

const QUOTE_DETAIL_INCLUDE = {
  branch: BRANCH_SELECT,
  customerContact: {
    select: { id: true, name: true, tax_id: true, email: true, phone: true },
  },
  createdBy: { select: { id: true, name: true, email: true } },
  lines: {
    orderBy: { sort_order: 'asc' },
    include: {
      product: { select: { id: true, name: true, barcode: true } },
    },
  },
  convertedChildren: {
    select: { id: true, reference: true, doc_type: true, status: true, created_at: true },
  },
  stock_reservations: {
    where: { status: 'ACTIVE', reservation_kind: 'QUOTE_SOFT' },
    select: { id: true, qty: true, expires_at: true, reservation_kind: true },
  },
}

const QUOTE_STATUS_TRANSITIONS = {
  DRAFT: new Set(['SENT', 'CANCELLED']),
  SENT: new Set(['ACCEPTED', 'REJECTED', 'CANCELLED']),
  ACCEPTED: new Set(['CANCELLED']),
  REJECTED: new Set([]),
  CANCELLED: new Set([]),
  EXPIRED: new Set([]),
}

const quoteWhereIdOrReference = (idOrRef) => {
  if (!idOrRef) return { id: '' }
  const s = String(idOrRef).trim()
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)
  if (isUuid) return { id: s, doc_type: QUOTE_DOC_TYPE }
  return { reference: s, doc_type: QUOTE_DOC_TYPE }
}

function parseSalesChannel(raw) {
  const sch = raw != null ? String(raw).toUpperCase() : 'WHOLESALE'
  return VALID_CHANNELS.has(sch) ? sch : 'WHOLESALE'
}

function defaultValidUntil(days = 30) {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return d
}

async function defaultValidUntilFromSettings(tx, companyId) {
  return defaultQuoteValidUntil(tx, companyId)
}

async function ensurePublicToken(tx, docId) {
  const doc = await tx.commercialDocument.findUnique({
    where: { id: docId },
    select: { public_token: true },
  })
  if (doc?.public_token) return doc.public_token

  let token = null
  for (let i = 0; i < 5; i++) {
    const candidate = crypto.randomBytes(24).toString('hex')
    const exists = await tx.commercialDocument.findFirst({ where: { public_token: candidate } })
    if (!exists) {
      token = candidate
      break
    }
  }
  if (!token) {
    const err = new Error('No se pudo generar enlace público')
    err.status = 500
    throw err
  }

  await tx.commercialDocument.update({
    where: { id: docId },
    data: { public_token: token },
  })
  return token
}

async function applyQuoteSoftHold(tx, quote, userId, companyId) {
  const lines = await tx.commercialDocumentLine.findMany({
    where: { document_id: quote.id },
    orderBy: { sort_order: 'asc' },
  })
  if (!lines.length) return

  await assertLinesAvailable(
    tx,
    lines.map((l) => ({ product_id: l.product_id, qty: l.qty })),
    { branchId: quote.branch_id }
  )
  await releaseByDocument(tx, quote.id, { status: 'RELEASED' })
  const expiresAt = await defaultQuoteSoftHoldExpiresAt(tx, companyId)
  await reserveForDocument(tx, {
    documentId: quote.id,
    documentLines: lines,
    expiresAt,
    createdBy: userId,
    reservationKind: 'QUOTE_SOFT',
    branchId: quote.branch_id,
  })
}

exports.getPublicByToken = async (req, res, next) => {
  try {
    const token = String(req.params.token || '').trim()
    if (!token) return res.status(400).json({ message: 'Token requerido' })

    const quote = await prisma.commercialDocument.findFirst({
      where: { public_token: token, doc_type: QUOTE_DOC_TYPE },
      include: {
        branch: { select: { company_id: true } },
        lines: {
          orderBy: { sort_order: 'asc' },
          include: { product: { select: { id: true, name: true, barcode: true } } },
        },
      },
    })
    if (!quote) return res.status(404).json({ message: 'Cotización no encontrada' })
    const moduleBlock = await getCompanyModuleBlock(quote.branch.company_id, 'quotes')
    if (moduleBlock) return res.status(403).json(moduleBlock)
    if (['CANCELLED', 'REJECTED'].includes(quote.status)) {
      return res.status(410).json({ message: 'Esta cotización ya no está disponible' })
    }

    const companyRows = await prisma.systemSetting.findMany({
      where: { key: { in: ['company_name', 'company_logo_url'] }, company_id: quote.branch.company_id },
    })
    const companyMap = Object.fromEntries(companyRows.map((r) => [r.key, r.value]))

    res.json({
      reference: quote.reference,
      status: quote.status,
      customer: quote.customer,
      customer_nit: quote.is_final_consumer ? null : quote.customer_nit,
      is_final_consumer: quote.is_final_consumer,
      valid_until: quote.valid_until,
      subtotal: quote.subtotal,
      total: quote.total,
      notes: quote.notes,
      company_name: companyMap.company_name || 'Depósito',
      company_logo_url: (companyMap.company_logo_url && String(companyMap.company_logo_url).trim()) || '',
      lines: quote.lines.map((l) => ({
        product_name: l.product?.name,
        barcode: l.product?.barcode,
        qty: l.qty,
        unit_price: l.unit_price,
        line_total: l.line_total,
      })),
    })
  } catch (e) {
    next(e)
  }
}

exports.getShareLink = async (req, res, next) => {
  try {
    const where = quoteWhereIdOrReference(req.params.id)
    const quote = await prisma.commercialDocument.findFirst({
      where: { ...where, branch: { company_id: req.companyId } },
    })
    if (!quote) return res.status(404).json({ message: 'Cotización no encontrada' })

    const token = await prisma.$transaction(async (tx) => ensurePublicToken(tx, quote.id))
    const base = String(process.env.PUBLIC_APP_URL || process.env.FRONTEND_URL || '').replace(/\/$/, '')
    const path = `/q/${token}`
    const public_url = base ? `${base}${path}` : path

    res.json({ public_token: token, public_url })
  } catch (e) {
    next(e)
  }
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

async function resolveQuoteLines(tx, items, ctx) {
  if (!Array.isArray(items) || items.length === 0) {
    const err = new Error('Debe incluir al menos un producto')
    err.status = 400
    throw err
  }

  const qtyByProduct = new Map()
  for (const it of items) {
    const pid = String(it.product_id)
    const q = Number(it.qty || 0)
    if (!pid || !Number.isFinite(q) || q <= 0) {
      const err = new Error('Cada línea debe incluir product_id y qty > 0')
      err.status = 400
      throw err
    }
    qtyByProduct.set(pid, (qtyByProduct.get(pid) || 0) + q)
  }

  const productIds = Array.from(qtyByProduct.keys())
  const products = await tx.product.findMany({
    where: { id: { in: productIds }, deleted: false },
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

  for (const pid of productIds) {
    const p = prodMap.get(pid)
    if (!p) {
      const err = new Error(`Producto no encontrado o eliminado: ${pid}`)
      err.status = 400
      throw err
    }
    if (!p.available_for_sale) {
      const err = new Error(`Producto no disponible para cotización: ${p.name}`)
      err.status = 400
      throw err
    }
  }

  const priceTier = ctx.explicitPriceTier
    ? ctx.explicitPriceTier
    : await resolvePriceTierForContext(tx, ctx)
  const priceNow = new Date()

  if (ctx.explicitPriceTier) {
    for (const pid of productIds) {
      const p = prodMap.get(pid)
      const check = productSupportsPriceTier(p, priceTier, priceNow)
      if (!check.ok) {
        const err = new Error(
          `Producto "${p.name}": ${check.reason === 'sin precio promocional' || check.reason === 'promoción vencida o no vigente' ? 'no tiene promoción activa' : check.reason}`
        )
        err.status = 400
        throw err
      }
    }
  }

  const normalized = []
  let sortOrder = 0
  for (const it of items) {
    const p = prodMap.get(String(it.product_id))
    const qty = Number(it.qty || 0)
    const unitPrice =
      it.unit_price != null && Number(it.unit_price) >= 0
        ? Number(it.unit_price)
        : resolveUnitPriceFromProduct(p, priceTier, priceNow)
    const lineTotal = Math.round(unitPrice * qty * 100) / 100
    normalized.push({
      product_id: p.id,
      qty,
      unit_price: new Prisma.Decimal(unitPrice),
      line_total: new Prisma.Decimal(lineTotal),
      sort_order: sortOrder++,
    })
  }

  const subtotal = normalized.reduce((acc, l) => acc + Number(l.line_total), 0)
  return {
    lines: normalized,
    subtotal: Math.round(subtotal * 100) / 100,
    total: Math.round(subtotal * 100) / 100,
  }
}

exports.list = async (req, res, next) => {
  try {
    const { status, search } = req.query || {}
    const page = Math.max(1, Number(req.query.page ?? 1))
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize ?? 25)))
    const searchTerm = String(search || '').trim()

    const where = { doc_type: QUOTE_DOC_TYPE, ...branchWhere(req) }
    // Filtrar por una sucursal solo tiene sentido en la vista consolidada, y solo
    // dentro de las que esa vista ya alcanza: un id suelto ensancharía el alcance
    // a otra empresa.
    const wantedBranch = req.query.branch_id ? String(req.query.branch_id) : null
    if (!req.branchId && wantedBranch && (req.branchIds || []).includes(wantedBranch)) {
      where.branch_id = wantedBranch
    }
    let searchMeta = null
    if (status && String(status).toUpperCase() !== 'ALL' && !searchTerm) {
      where.status = String(status).toUpperCase()
    }
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

    const totalItems = await prisma.commercialDocument.count({ where })
    const totalPages = Math.max(1, Math.ceil(totalItems / pageSize))
    const safePage = Math.min(page, totalPages)

    const items = await prisma.commercialDocument.findMany({
      where,
      include: QUOTE_LIST_INCLUDE,
      orderBy: { created_at: 'desc' },
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
      ...(searchMeta ? { searchMeta } : {}),
    })
  } catch (e) {
    next(e)
  }
}

exports.getById = async (req, res, next) => {
  try {
    const where = { ...quoteWhereIdOrReference(req.params.id), branch: { company_id: req.companyId } }
    const doc = await prisma.commercialDocument.findFirst({
      where,
      include: QUOTE_DETAIL_INCLUDE,
    })
    if (!doc) return res.status(404).json({ message: 'Cotización no encontrada' })
    res.json(doc)
  } catch (e) {
    next(e)
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
      price_tier: priceTierRaw,
    } = req.body || {}

    const salesChannel = parseSalesChannel(salesChannelRaw)
    const explicitPriceTier = parsePriceTier(priceTierRaw)
    let customerContactId = null
    if (customerContactIdRaw != null && String(customerContactIdRaw).trim() !== '') {
      customerContactId = String(customerContactIdRaw).trim()
    }

    const branchId = targetBranch(req, req.body?.branch_id)

    const created = await prismaTransaction.$transaction(async (tx) => {
      await validateCustomerContact(tx, customerContactId)
      const { lines, subtotal, total } = await resolveQuoteLines(tx, items, {
        customerContactId,
        salesChannel,
        explicitPriceTier,
      })

      await assertLinesAvailable(
        tx,
        lines.map((l) => ({ product_id: l.product_id, qty: l.qty })),
        { branchId }
      )

      let validUntil = null
      if (validUntilRaw) {
        validUntil = new Date(validUntilRaw)
        if (Number.isNaN(validUntil.getTime())) {
          const err = new Error('valid_until inválido')
          err.status = 400
          throw err
        }
      } else {
        validUntil = await defaultValidUntilFromSettings(tx, req.companyId)
      }

      const branch = await loadBranch(tx, branchId)
      const reference = await nextDocumentReference(tx, 'Q', branch)

      const doc = await tx.commercialDocument.create({
        data: {
          branch_id: branchId,
          reference,
          doc_type: QUOTE_DOC_TYPE,
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
        include: QUOTE_DETAIL_INCLUDE,
      })
      return doc
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

    const where = { ...quoteWhereIdOrReference(req.params.id), branch: { company_id: req.companyId } }
    const existing = await prisma.commercialDocument.findFirst({ where })
    if (!existing) return res.status(404).json({ message: 'Cotización no encontrada' })
    if (existing.status !== 'DRAFT') {
      return res.status(400).json({ message: 'Solo se pueden editar cotizaciones en borrador' })
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
      price_tier: priceTierRaw,
    } = req.body || {}

    const salesChannel = parseSalesChannel(salesChannelRaw ?? existing.sales_channel)
    const explicitPriceTier = parsePriceTier(priceTierRaw)
    let customerContactId = existing.customer_contact_id
    if (customerContactIdRaw !== undefined) {
      customerContactId =
        customerContactIdRaw != null && String(customerContactIdRaw).trim() !== ''
          ? String(customerContactIdRaw).trim()
          : null
    }

    const updated = await prismaTransaction.$transaction(async (tx) => {
      await validateCustomerContact(tx, customerContactId)
      const { lines, subtotal, total } = await resolveQuoteLines(tx, items, {
        customerContactId,
        salesChannel,
        explicitPriceTier,
      })

      await assertLinesAvailable(
        tx,
        lines.map((l) => ({ product_id: l.product_id, qty: l.qty })),
        { branchId: existing.branch_id }
      )

      let validUntil = existing.valid_until
      if (validUntilRaw !== undefined) {
        if (validUntilRaw == null || validUntilRaw === '') {
          validUntil = await defaultValidUntilFromSettings(tx, req.companyId)
        } else {
          validUntil = new Date(validUntilRaw)
          if (Number.isNaN(validUntil.getTime())) {
            const err = new Error('valid_until inválido')
            err.status = 400
            throw err
          }
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
        include: QUOTE_DETAIL_INCLUDE,
      })
    })

    res.json(updated)
  } catch (e) {
    next(e)
  }
}

exports.updateStatus = async (req, res, next) => {
  try {
    const { status: newStatusRaw } = req.body || {}
    const newStatus = String(newStatusRaw || '').toUpperCase()
    if (!newStatus) return res.status(400).json({ message: 'status requerido' })

    const where = { ...quoteWhereIdOrReference(req.params.id), branch: { company_id: req.companyId } }
    const existing = await prisma.commercialDocument.findFirst({
      where,
      include: { _count: { select: { lines: true } } },
    })
    if (!existing) return res.status(404).json({ message: 'Cotización no encontrada' })

    const allowed = QUOTE_STATUS_TRANSITIONS[existing.status]
    if (!allowed || !allowed.has(newStatus)) {
      return res.status(400).json({
        message: `No se puede cambiar de ${existing.status} a ${newStatus}`,
      })
    }

    if (newStatus === 'SENT' && (existing._count?.lines || 0) === 0) {
      return res.status(400).json({ message: 'La cotización debe tener al menos una línea' })
    }

    if (newStatus === 'EXPIRED' && existing.valid_until && new Date(existing.valid_until) > new Date()) {
      return res.status(400).json({ message: 'La cotización aún no ha vencido' })
    }

    const user = req.user
    const userId = user?.sub || null

    const updated = await prismaTransaction.$transaction(async (tx) => {
      if (newStatus === 'SENT') {
        await ensurePublicToken(tx, existing.id)
        await applyQuoteSoftHold(tx, existing, userId, req.companyId)
      } else if (['REJECTED', 'CANCELLED', 'EXPIRED'].includes(newStatus)) {
        await releaseByDocument(tx, existing.id, { status: 'RELEASED' })
      }

      return tx.commercialDocument.update({
        where: { id: existing.id },
        data: { status: newStatus },
        include: QUOTE_DETAIL_INCLUDE,
      })
    })

    res.json(updated)
  } catch (e) {
    next(e)
  }
}

exports.convertToOrder = async (req, res, next) => {
  try {
    const user = req.user
    if (!user?.sub) return res.status(401).json({ message: 'Usuario no autenticado' })

    const where = { ...quoteWhereIdOrReference(req.params.id), branch: { company_id: req.companyId } }
    const quote = await prisma.commercialDocument.findFirst({
      where,
      include: { lines: { orderBy: { sort_order: 'asc' } } },
    })
    if (!quote) return res.status(404).json({ message: 'Cotización no encontrada' })

    if (quote.status !== 'ACCEPTED') {
      return res.status(400).json({
        message: 'Solo se pueden convertir cotizaciones aceptadas',
      })
    }

    const existingOrder = await prisma.commercialDocument.findFirst({
      where: { converted_from_id: quote.id, doc_type: ORDER_DOC_TYPE },
      select: { id: true, reference: true, status: true },
    })
    if (existingOrder) {
      return res.status(409).json({
        message: 'Esta cotización ya tiene un pedido vinculado',
        order: existingOrder,
      })
    }

    const order = await prismaTransaction.$transaction(async (tx) => {
      await releaseByDocument(tx, quote.id, { status: 'RELEASED' })
      // El pedido hereda la sucursal de la cotización
      const branch = await loadBranch(tx, quote.branch_id)
      const reference = await nextDocumentReference(tx, 'P', branch)
      const lines = quote.lines.map((l, idx) => ({
        product_id: l.product_id,
        qty: l.qty,
        unit_price: l.unit_price,
        line_total: l.line_total,
        sort_order: idx,
      }))

      return tx.commercialDocument.create({
        data: {
          branch_id: quote.branch_id,
          reference,
          doc_type: ORDER_DOC_TYPE,
          status: 'DRAFT',
          valid_until: quote.valid_until,
          customer: quote.customer,
          customer_nit: quote.customer_nit,
          is_final_consumer: quote.is_final_consumer,
          customer_contact_id: quote.customer_contact_id,
          sales_channel: quote.sales_channel,
          subtotal: quote.subtotal,
          discount_total: quote.discount_total ?? new Prisma.Decimal(0),
          total: quote.total,
          notes: quote.notes,
          converted_from_id: quote.id,
          created_by: user.sub,
          lines: { create: lines },
        },
        include: {
          customerContact: { select: { id: true, name: true, tax_id: true } },
          createdBy: { select: { id: true, name: true } },
          lines: {
            orderBy: { sort_order: 'asc' },
            include: { product: { select: { id: true, name: true, barcode: true } } },
          },
        },
      })
    })

    res.status(201).json(order)
  } catch (e) {
    next(e)
  }
}
