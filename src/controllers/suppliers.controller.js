/**
 * Copyright (c) 2026 Diego Patzán. All Rights Reserved.
 * 
 * This source code is licensed under a Proprietary License.
 * Unauthorized copying, modification, distribution, or use of this file,
 * via any medium, is strictly prohibited without express written permission.
 * 
 * For licensing inquiries: GitHub @dpatzan2
 */

const { prisma } = require('../models/prisma')
const { DateTime } = require('luxon')
const { getTimezone } = require('../utils/getTimezone')
const {
  assertPartyAction,
  listablePartyTypes,
  normalizePartyType,
  PARTY,
} = require('../utils/contactsPermissions')

function normalizeTaxId(raw) {
  if (raw === undefined) return undefined
  if (raw === null || raw === '') return null
  const s = String(raw).trim()
  return s.length ? s : null
}

/** @returns {'PERSON'|'ORGANIZATION'} */
function normalizeEntityKind(raw) {
  if (raw === undefined || raw === null || raw === '') return 'ORGANIZATION'
  const s = String(raw).toUpperCase().trim()
  if (s === 'PERSON' || s === 'INDIVIDUAL' || s === 'NATURAL') return 'PERSON'
  if (s === 'ORGANIZATION' || s === 'ORG' || s === 'COMPANY' || s === 'EMPRESA') return 'ORGANIZATION'
  return 'ORGANIZATION'
}

/**
 * @param {{ entityKind: 'PERSON'|'ORGANIZATION', name: string, contact?: string|null }} p
 * @returns {{ ok: true, name: string, contact: string } | { ok: false, message: string }}
 */
function resolveContactForEntityKind(p) {
  const name = String(p.name || '').trim()
  let contact = p.contact != null ? String(p.contact).trim() : ''
  if (p.entityKind === 'PERSON') {
    if (!name) return { ok: false, message: 'El nombre es requerido' }
    if (!contact) contact = name
    return { ok: true, name, contact }
  }
  if (!name) return { ok: false, message: 'El nombre o razón social es requerido' }
  if (!contact) return { ok: false, message: 'La persona de contacto es requerida para una empresa' }
  return { ok: true, name, contact }
}

/**
 * @param {object} body
 * @returns {{ ok: true, links: { payment_term_id: number, is_default: boolean, sort_order: number }[] } | { ok: false, message: string }}
 */
function parsePaymentTermsPayload(body) {
  if (body.payment_terms != null && Array.isArray(body.payment_terms)) {
    const raw = body.payment_terms
    if (raw.length === 0) {
      return { ok: false, message: 'Debe indicar al menos un término de pago' }
    }
    const links = []
    let defaultCount = 0
    for (let i = 0; i < raw.length; i++) {
      const row = raw[i]
      const id = row.payment_term_id != null ? row.payment_term_id : row.id
      if (id == null || id === '') continue
      const pid = Number(id)
      if (!Number.isFinite(pid)) {
        return { ok: false, message: 'payment_terms: id de término inválido' }
      }
      const isDef = Boolean(row.is_default)
      if (isDef) defaultCount++
      links.push({
        payment_term_id: pid,
        is_default: isDef,
        sort_order: row.sort_order != null ? Number(row.sort_order) : i,
      })
    }
    const seen = new Set()
    for (const l of links) {
      if (seen.has(l.payment_term_id)) {
        return { ok: false, message: 'Términos de pago duplicados' }
      }
      seen.add(l.payment_term_id)
    }
    if (links.length === 0) {
      return { ok: false, message: 'Debe indicar al menos un término de pago' }
    }
    if (defaultCount !== 1) {
      return { ok: false, message: 'Debe marcar exactamente un término de pago como predeterminado' }
    }
    return { ok: true, links }
  }
  if (body.payment_terms_id != null && body.payment_terms_id !== '') {
    const pid = Number(body.payment_terms_id)
    if (!Number.isFinite(pid)) {
      return { ok: false, message: 'payment_terms_id inválido' }
    }
    return { ok: true, links: [{ payment_term_id: pid, is_default: true, sort_order: 0 }] }
  }
  return { ok: false, message: 'payment_terms o payment_terms_id es requerido' }
}

/**
 * Límite de crédito de un cliente. Vacío = sin límite (no es lo mismo que 0,
 * que significa «no se le vende nada al crédito»).
 */
function normalizeCreditLimit(raw) {
  if (raw === null || raw === undefined || String(raw).trim() === '') {
    return { ok: true, value: null }
  }
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) {
    return { ok: false, message: 'El límite de crédito debe ser un número mayor o igual a 0' }
  }
  if (n > 99999999.99) {
    return { ok: false, message: 'El límite de crédito excede el máximo permitido' }
  }
  return { ok: true, value: Number(n.toFixed(2)) }
}

function shapeSupplierResponse(s) {
  const links = Array.isArray(s.supplier_payment_terms)
    ? [...s.supplier_payment_terms].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
    : []
  const payment_terms = links.map((l) => ({
    payment_term_id: l.payment_term_id,
    is_default: l.is_default,
    sort_order: l.sort_order,
    name: l.payment_term?.name ?? '',
    net_days: l.payment_term?.net_days != null ? Number(l.payment_term.net_days) : null,
  }))
  const def = links.find((l) => l.is_default) || links[0]
  const payment_terms_id = def?.payment_term_id ?? null
  const payment_term = def?.payment_term ?? null
  const { supplier_payment_terms: _omit, ...rest } = s
  return {
    ...rest,
    credit_limit: rest.credit_limit == null ? null : Number(rest.credit_limit),
    payment_terms,
    payment_terms_id,
    payment_term,
  }
}

exports.list = async (req, res, next) => {
  try {
    const lt = listablePartyTypes(req.user, req.query.party_type)
    if (lt.error) return res.status(lt.error).json({ message: lt.message })

    const page = Math.max(1, Number(req.query.page ?? 1))
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize ?? 20)))
    const { search, category_id } = req.query || {}

    if (lt.types.length === 0) {
      return res.json({
        items: [],
        page: 1,
        pageSize,
        totalPages: 1,
        totalItems: 0,
        nextPage: null,
        prevPage: null,
      })
    }

    const where = { deleted: false, party_type: { in: lt.types }, company_id: req.companyId }

    if (search) {
      const q = String(search)
      where.OR = [
        { name: { contains: q, mode: 'insensitive' } },
        { contact: { contains: q, mode: 'insensitive' } },
        { email: { contains: q, mode: 'insensitive' } },
        { tax_id: { contains: q, mode: 'insensitive' } },
      ]
    }

    if (category_id) {
      const categoryIdNum = Number(category_id)
      if (!Number.isNaN(categoryIdNum)) {
        where.categories = {
          some: { category_id: categoryIdNum },
        }
      }
    }

    const totalItems = await prisma.supplier.count({ where })
    const totalPages = Math.max(1, Math.ceil(totalItems / pageSize))
    const safePage = Math.min(page, totalPages)
    
    const items = await prisma.supplier.findMany({
      where,
      include: {
        categories: {
          include: {
            category: true,
          },
        },
        supplier_payment_terms: {
          include: { payment_term: true },
          orderBy: { sort_order: 'asc' },
        },
        productsList: true,
      },
      orderBy: { name: 'asc' },
      skip: (safePage - 1) * pageSize,
      take: pageSize,
    })

    const tz = await getTimezone(prisma, req.companyId)
    const adapted = items.map(s => {
      const shaped = shapeSupplierResponse(s)
      let lastOrder = ''
      if (s.last_order) {
        lastOrder = DateTime.fromJSDate(s.last_order).setZone(tz).setLocale('es').toFormat("dd LLL yyyy HH:mm")
      }

      const categories =
        Array.isArray(s.categories)
          ? s.categories
              .map(sc => sc.category)
              .filter(Boolean)
          : []

      const categoryNames = categories.map(c => c.name)

      return {
        ...shaped,
        totalPurchases: Number(s.total_purchases || 0),
        lastOrder,
        categories,
        categoryNames,
      }
    })
    
    const nextPage = safePage < totalPages ? safePage + 1 : null
    const prevPage = safePage > 1 ? safePage - 1 : null
    
    res.json({
      items: adapted,
      page: safePage,
      pageSize,
      totalPages,
      totalItems,
      nextPage,
      prevPage
    })
  } catch (e) { next(e) }
}

exports.create = async (req, res, next) => {
  try {
    const body = req.body || {}
    const { productsList, ...data } = body
    const partyType = normalizePartyType(data.party_type)
    try {
      assertPartyAction(req.user, partyType, 'create')
    } catch (err) {
      return res.status(err.statusCode || 403).json({ message: err.message })
    }

    const entityKind = normalizeEntityKind(data.entity_kind)
    const resolved = resolveContactForEntityKind({
      entityKind,
      name: data.name,
      contact: data.contact,
    })
    if (!resolved.ok) {
      return res.status(400).json({ message: resolved.message })
    }

    const createData = {
      party_type: partyType,
      entity_kind: entityKind,
      name: resolved.name,
      contact: resolved.contact,
      phone: data.phone,
      email: data.email,
      address: data.address,
      products: data.products ?? 0,
      total_purchases: data.total_purchases ?? 0,
      rating: data.rating ?? null,
    }
    if (data.tax_id !== undefined) {
      createData.tax_id = normalizeTaxId(data.tax_id)
    }
    if (partyType === PARTY.CUSTOMER && data.credit_limit !== undefined) {
      const cl = normalizeCreditLimit(data.credit_limit)
      if (!cl.ok) return res.status(400).json({ message: cl.message })
      createData.credit_limit = cl.value
    }

    if (partyType === PARTY.SUPPLIER) {
      const rawCategoryIds = Array.isArray(data.category_ids)
        ? data.category_ids
        : (data.category_id != null ? [data.category_id] : [])

      const categoryIds = rawCategoryIds
        .map(id => Number(id))
        .filter(id => Number.isFinite(id))

      if (categoryIds.length === 0) {
        return res.status(400).json({ message: 'Debe indicar al menos una categoría para un proveedor' })
      }
      createData.categories = {
        create: categoryIds.map(id => ({
          category: { connect: { id } },
        })),
      }
    }

    const ptParsed = parsePaymentTermsPayload(data)
    if (!ptParsed.ok) {
      return res.status(400).json({ message: ptParsed.message })
    }
    createData.supplier_payment_terms = {
      create: ptParsed.links.map((l) => ({
        payment_term_id: l.payment_term_id,
        is_default: l.is_default,
        sort_order: l.sort_order,
      })),
    }

    createData.estado = data.estado !== undefined && data.estado !== null ? Number(data.estado) : 1
    createData.company_id = req.companyId

    const created = await prisma.supplier.create({
      data: createData,
      include: {
        supplier_payment_terms: { include: { payment_term: true }, orderBy: { sort_order: 'asc' } },
      },
    })
    res.status(201).json(shapeSupplierResponse(created))
  } catch (e) { next(e) }
}

exports.getOne = async (req, res, next) => {
  try {
    const item = await prisma.supplier.findFirst({
      where: { id: req.params.id, company_id: req.companyId },
      include: {
        categories: {
          include: {
            category: true,
          },
        },
        supplier_payment_terms: {
          include: { payment_term: true },
          orderBy: { sort_order: 'asc' },
        },
        productsList: true,
        customer_price_rules: {
          orderBy: [{ priority: 'desc' }, { created_at: 'asc' }],
        },
      },
    })
    if (!item || item.deleted) return res.status(404).json({ message: 'No encontrado' })
    try {
      assertPartyAction(req.user, item.party_type, 'view')
    } catch (err) {
      return res.status(err.statusCode || 403).json({ message: err.message })
    }
    const categories =
      Array.isArray(item.categories)
        ? item.categories
            .map(sc => sc.category)
            .filter(Boolean)
        : []
    const categoryNames = categories.map(c => c.name)

    const tz = await getTimezone(prisma, req.companyId)
    const shaped = shapeSupplierResponse(item)
    const adapted = {
      ...shaped,
      totalPurchases: Number(item.total_purchases || 0),
      lastOrder: item.last_order ? DateTime.fromJSDate(item.last_order).setZone(tz).setLocale('es').toFormat('dd LLL yyyy HH:mm') : '',
      categories,
      categoryNames,
    }
    res.json(adapted)
  } catch (e) { next(e) }
}

exports.update = async (req, res, next) => {
  try {
    const existing = await prisma.supplier.findFirst({
      where: { id: req.params.id, company_id: req.companyId },
      include: { productsList: { select: { id: true } } },
    })
    if (!existing || existing.deleted) {
      return res.status(404).json({ message: 'No encontrado' })
    }
    try {
      assertPartyAction(req.user, existing.party_type, 'edit')
    } catch (err) {
      return res.status(err.statusCode || 403).json({ message: err.message })
    }

    const body = req.body || {}
    const { productsList, ...data } = body

    const updateData = {}
    const nextEntityKind =
      data.entity_kind !== undefined ? normalizeEntityKind(data.entity_kind) : existing.entity_kind
    const nextName = data.name !== undefined ? String(data.name).trim() : existing.name
    const nextContact =
      data.contact !== undefined ? String(data.contact).trim() : existing.contact

    if (
      data.entity_kind !== undefined ||
      data.name !== undefined ||
      data.contact !== undefined
    ) {
      const resolved = resolveContactForEntityKind({
        entityKind: nextEntityKind,
        name: nextName,
        contact: nextContact,
      })
      if (!resolved.ok) {
        return res.status(400).json({ message: resolved.message })
      }
      updateData.entity_kind = nextEntityKind
      updateData.name = resolved.name
      updateData.contact = resolved.contact
    }
    if (data.phone !== undefined) updateData.phone = data.phone
    if (data.email !== undefined) updateData.email = data.email
    if (data.address !== undefined) updateData.address = data.address
    if (data.tax_id !== undefined) updateData.tax_id = normalizeTaxId(data.tax_id)
    if (data.products !== undefined) updateData.products = data.products
    if (data.total_purchases !== undefined) updateData.total_purchases = data.total_purchases
    if (data.rating !== undefined) updateData.rating = data.rating

    const effectiveParty =
      data.party_type !== undefined ? normalizePartyType(data.party_type) : existing.party_type

    if (data.party_type !== undefined && effectiveParty !== existing.party_type) {
      if (effectiveParty === PARTY.CUSTOMER && (existing.productsList?.length ?? 0) > 0) {
        return res.status(400).json({
          message: 'No se puede marcar como cliente: tiene productos asignados como proveedor',
        })
      }
      try {
        assertPartyAction(req.user, effectiveParty, 'edit')
      } catch (err) {
        return res.status(err.statusCode || 403).json({ message: err.message })
      }
      updateData.party_type = effectiveParty
    }

    if (
      effectiveParty === PARTY.SUPPLIER &&
      (data.category_ids != null || data.category_id != null)
    ) {
      const rawCategoryIds = Array.isArray(data.category_ids)
        ? data.category_ids
        : (data.category_id != null ? [data.category_id] : [])

      const categoryIds = rawCategoryIds
        .map(id => Number(id))
        .filter(id => Number.isFinite(id))

      updateData.categories = {
        deleteMany: {},
        create: categoryIds.map(id => ({
          category: { connect: { id } },
        })),
      }
    } else if (effectiveParty === PARTY.CUSTOMER && (data.category_ids != null || data.category_id != null)) {
      updateData.categories = { deleteMany: {} }
    }
    if (data.payment_terms != null || data.payment_terms_id != null) {
      const ptParsed = parsePaymentTermsPayload(data)
      if (!ptParsed.ok) {
        return res.status(400).json({ message: ptParsed.message })
      }
      updateData.supplier_payment_terms = {
        deleteMany: {},
        create: ptParsed.links.map((l) => ({
          payment_term_id: l.payment_term_id,
          is_default: l.is_default,
          sort_order: l.sort_order,
        })),
      }
    }
    if (data.estado !== undefined && data.estado !== null) {
      updateData.estado = Number(data.estado)
    }
    if (effectiveParty === PARTY.CUSTOMER && data.credit_limit !== undefined) {
      const cl = normalizeCreditLimit(data.credit_limit)
      if (!cl.ok) return res.status(400).json({ message: cl.message })
      updateData.credit_limit = cl.value
    } else if (effectiveParty === PARTY.SUPPLIER && existing.party_type === PARTY.CUSTOMER) {
      // Dejó de ser cliente: el límite ya no aplica y quedaría de fantasma si
      // algún día vuelve a serlo.
      updateData.credit_limit = null
    }
    if (existing.party_type === PARTY.CUSTOMER && data.default_price_tier !== undefined) {
      const t = String(data.default_price_tier || '').toUpperCase()
      if (['LIST', 'WHOLESALE', 'PROMOTION'].includes(t)) {
        updateData.default_price_tier = t
      }
    }

    const updated = await prisma.supplier.update({
      where: { id: req.params.id },
      data: updateData,
      include: {
        supplier_payment_terms: { include: { payment_term: true }, orderBy: { sort_order: 'asc' } },
      },
    })
    res.json(shapeSupplierResponse(updated))
  } catch (e) { next(e) }
}

exports.remove = async (req, res, next) => {
  try {
    const row = await prisma.supplier.findFirst({ where: { id: req.params.id, company_id: req.companyId } })
    if (!row || row.deleted) return res.status(404).json({ message: 'No encontrado' })
    try {
      assertPartyAction(req.user, row.party_type, 'delete')
    } catch (err) {
      return res.status(err.statusCode || 403).json({ message: err.message })
    }

    await prisma.supplier.update({ where: { id: req.params.id }, data: { deleted: true, deleted_at: new Date() } })
    res.json({ ok: true })
  } catch (e) { next(e) }
}

const PRICE_TIERS = new Set(['LIST', 'WHOLESALE', 'PROMOTION'])
const SALE_CHANNELS = new Set(['POS', 'WHOLESALE', 'ONLINE'])

exports.listCustomerPriceRules = async (req, res, next) => {
  try {
    const row = await prisma.supplier.findFirst({
      where: { id: req.params.id, company_id: req.companyId },
      select: { id: true, deleted: true, party_type: true },
    })
    if (!row || row.deleted) return res.status(404).json({ message: 'No encontrado' })
    try {
      assertPartyAction(req.user, row.party_type, 'view')
    } catch (err) {
      return res.status(err.statusCode || 403).json({ message: err.message })
    }
    if (row.party_type !== PARTY.CUSTOMER) {
      return res.status(400).json({ message: 'Las reglas de precio solo aplican a clientes' })
    }
    const rules = await prisma.customerPriceRule.findMany({
      where: { supplier_id: row.id },
      orderBy: [{ priority: 'desc' }, { created_at: 'asc' }],
    })
    res.json({ rules })
  } catch (e) {
    next(e)
  }
}

exports.replaceCustomerPriceRules = async (req, res, next) => {
  try {
    const { randomUUID } = require('crypto')
    const row = await prisma.supplier.findFirst({
      where: { id: req.params.id, company_id: req.companyId },
      select: { id: true, deleted: true, party_type: true },
    })
    if (!row || row.deleted) return res.status(404).json({ message: 'No encontrado' })
    try {
      assertPartyAction(req.user, row.party_type, 'edit')
    } catch (err) {
      return res.status(err.statusCode || 403).json({ message: err.message })
    }
    if (row.party_type !== PARTY.CUSTOMER) {
      return res.status(400).json({ message: 'Las reglas de precio solo aplican a clientes' })
    }

    const { rules } = req.body || {}
    if (!Array.isArray(rules)) {
      return res.status(400).json({ message: 'rules debe ser un arreglo' })
    }

    const rows = []
    for (let i = 0; i < rules.length; i++) {
      const r = rules[i] || {}
      const tier = String(r.price_tier ?? r.tier ?? '').toUpperCase()
      if (!PRICE_TIERS.has(tier)) {
        return res.status(400).json({ message: `price_tier inválido en índice ${i}` })
      }
      let channel = null
      if (r.channel != null && r.channel !== '') {
        const c = String(r.channel).toUpperCase()
        if (!SALE_CHANNELS.has(c)) {
          return res.status(400).json({ message: `channel inválido en índice ${i}` })
        }
        channel = c
      }
      rows.push({
        id: randomUUID(),
        supplier_id: row.id,
        channel,
        price_tier: tier,
        priority: Number.isFinite(Number(r.priority)) ? Number(r.priority) : 0,
        active: r.active !== false,
      })
    }

    await prisma.$transaction(async (trx) => {
      await trx.customerPriceRule.deleteMany({ where: { supplier_id: row.id } })
      if (rows.length > 0) {
        await trx.customerPriceRule.createMany({ data: rows })
      }
    })

    const updated = await prisma.customerPriceRule.findMany({
      where: { supplier_id: row.id },
      orderBy: [{ priority: 'desc' }, { created_at: 'asc' }],
    })
    res.json({ rules: updated })
  } catch (e) {
    next(e)
  }
}

// ========== BULK IMPORT METHODS ==========

const { bulkValidateSuppliers, bulkCreateSuppliers, generateSupplierTemplate } = require('../services/supplierBulkImport')

/**
 * @swagger
 * /api/suppliers/bulk-import-mapped:
 *   post:
 *     summary: Importar proveedores desde JSON mapeado
 *     description: Valida y crea proveedores desde datos JSON con columnas ya mapeadas
 *     tags: [Suppliers]
 *     security:
 *       - bearerAuth: []
 */
exports.bulkImportMapped = async (req, res, next) => {
  try {
    const { suppliers, importOptions } = req.body

    if (!suppliers || !Array.isArray(suppliers) || suppliers.length === 0) {
      return res.status(400).json({ message: 'No se proporcionaron contactos' })
    }

    const validation = await bulkValidateSuppliers(suppliers, importOptions, { companyId: req.companyId })

    if (validation.invalidRows.length > 0) {
      return res.status(400).json({
        ok: false,
        message: `${validation.invalidRows.length} filas tienen errores`,
        ...validation
      })
    }

    const result = await bulkCreateSuppliers(validation.validRows, importOptions, { companyId: req.companyId })

    res.json({
      ok: true,
      created: result.created,
      skipped: result.skipped || 0,
      errors: result.errors || [],
      message: result.skipped > 0
        ? `Se importaron ${result.created} contactos (${result.skipped} omitidos por error)`
        : `Se importaron ${result.created} contactos exitosamente`
    })
  } catch (e) {
    next(e)
  }
}

/**
 * @swagger
 * /api/suppliers/validate-import-mapped:
 *   post:
 *     summary: Validar proveedores sin importar
 *     description: Valida proveedores desde JSON y retorna errores sin crear registros
 *     tags: [Suppliers]
 *     security:
 *       - bearerAuth: []
 */
exports.validateImportMapped = async (req, res, next) => {
  try {
    const { suppliers, importOptions } = req.body

    if (!suppliers || !Array.isArray(suppliers) || suppliers.length === 0) {
      return res.status(400).json({ message: 'No se proporcionaron contactos' })
    }

    const validation = await bulkValidateSuppliers(suppliers, importOptions, { companyId: req.companyId })

    res.json({
      ok: validation.invalidRows.length === 0,
      ...validation
    })
  } catch (e) {
    // Log error for debugging
    console.error('[suppliers.validateImportMapped] Error:', e)
    // Return a proper error response
    if (e.code === 'P1001' || e.message?.includes('Can\'t reach database')) {
      return res.status(503).json({ 
        message: 'Error de conexión con la base de datos. Por favor, intenta nuevamente.',
        error: 'Database connection error'
      })
    }
    next(e)
  }
}

/**
 * @swagger
 * /api/suppliers/template:
 *   get:
 *     summary: Descargar plantilla Excel para proveedores
 *     tags: [Suppliers]
 */
exports.downloadTemplate = async (req, res, next) => {
  try {
    const buffer = await generateSupplierTemplate(req.companyId)

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', 'attachment; filename="plantilla_contactos.xlsx"')
    res.send(buffer)
  } catch (e) {
    next(e)
  }
}

