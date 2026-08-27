/**
 * Copyright (c) 2026 Diego Patzán. All Rights Reserved.
 * 
 * This source code is licensed under a Proprietary License.
 * Unauthorized copying, modification, distribution, or use of this file,
 * via any medium, is strictly prohibited without express written permission.
 * 
 * For licensing inquiries: GitHub @dpatzan2
 */

const { prisma, prismaTransaction } = require('../models/prisma')
const { Prisma } = require('@prisma/client')
const { DateTime } = require('luxon')
const { getTimezone } = require('../utils/getTimezone')
const { ensureStockAlertsBatch } = require('../services/stockAlerts')
const { consumeLotsFEFO, restoreLotsFEFO } = require('../services/lots')
const { dispatchedByRef } = require('../services/stockLocations')
const { salesOperationLimiter } = require('../utils/concurrencyLimiter')
const {
  assertPartyAction,
  PARTY,
  userHasPerm,
} = require('../utils/contactsPermissions')
const { resolvePriceTierForContext, resolveUnitPriceFromProduct, VALID_CHANNELS } = require('../services/priceResolution')
const {
  appendSaleSearchFilter,
  MIN_TEXT_SEARCH_LEN,
} = require('../services/saleSearch')
const { expandLinesToStockMap, deductStockMap, restoreStockMap, getAvailabilityBatchWithKits } = require('../services/bomStock')
const { nextDocumentReference } = require('../services/referenceGenerator')
const { requireBranch, branchWhere, hasPerm } = require('../middlewares/tenant')
const { checkCredit, lockCustomer } = require('../services/receivables')

/** Caja de la venta: la explícita (POS) > la asignada al usuario > la predeterminada. */
async function resolveSaleRegister (client, explicitId, userId, branchId) {
  if (explicitId) {
    return client.cashRegister.findFirst({
      where: { id: String(explicitId), active: true, branch_id: branchId },
    })
  }
  if (userId) {
    const u = await client.user.findUnique({
      where: { id: String(userId) },
      select: { cashRegister: { select: { id: true, active: true, branch_id: true } } }
    })
    if (u?.cashRegister?.active && u.cashRegister.branch_id === branchId) return u.cashRegister
  }
  return client.cashRegister.findFirst({
    where: { is_default: true, active: true, branch_id: branchId },
  })
}

/** Include ligero para listados (tabla / búsqueda). Detalle completo en GET /sales/:id */
const SALE_LIST_INCLUDE = {
  payment_method: { select: { id: true, name: true } },
  status: { select: { id: true, name: true } },
}

/** Misma forma que GET /sales/:id — reutilizado al responder POST /sales (evita un GET extra en el cliente). */
const SALE_DETAIL_INCLUDE = {
  payment_method: true,
  status: true,
  sale_items: {
    include: {
      product: {
        select: {
          id: true,
          name: true,
          barcode: true
        }
      }
    }
  },
  sale_dtes: true,
  returns: {
    include: {
      status: true,
      return_items: {
        include: {
          product: {
            select: {
              id: true,
              name: true,
              barcode: true
            }
          }
        }
      }
    },
    orderBy: {
      return_date: 'desc'
    }
  },
  createdBy: {
    select: {
      id: true,
      name: true,
      email: true
    }
  }
}

exports.list = async (req, res, next) => {
  try {
    // Query params: period (today|week|month|year), status, page, pageSize, customer_contact_id, search
    const { period, status, customer_contact_id: customerContactId, search } = req.query || {}
    const page = Math.max(1, Number(req.query.page ?? 1))
    const pageSize = Math.min(1000, Math.max(1, Number(req.query.pageSize ?? 100)))
    const searchTerm = String(search || '').trim()

    let startDate
    let endDate
    if (period && !searchTerm) {
      const tz = await getTimezone(prisma, req.companyId)
      const nowGt = DateTime.now().setZone(tz)
      let startGt
      let endGt
      switch (String(period)) {
        case 'today':
          startGt = nowGt.startOf('day')
          endGt = nowGt.endOf('day')
          break
        case 'week':
          startGt = nowGt.startOf('week')
          endGt = nowGt.endOf('week')
          break
        case 'month':
          startGt = nowGt.startOf('month')
          endGt = nowGt.endOf('month')
          break
        case 'year':
          startGt = nowGt.startOf('year')
          endGt = nowGt.endOf('year')
          break
        default:
          startGt = null
          endGt = null
      }

      if (startGt && endGt) {
        // `.toJSDate()` ya hace la conversión de zona correcta (instante UTC
        // real de ese momento zonificado). Reconstruirlo a mano con Date.UTC
        // a partir de los números de la zona los reetiquetaba como si fueran
        // UTC — mismo bug que en la creación de la venta, ver más abajo.
        startDate = startGt.toJSDate()
        endDate = endGt.toJSDate()
      }
    }

    const where = { ...branchWhere(req) }
    if (startDate && endDate) {
      where.date = { gte: startDate, lte: endDate }
    }
    if (status) {
      // filter by related status name (e.g., ?status=pendiente)
      where.status = { name: String(status) }
    }

    let searchMeta = null
    if (searchTerm) {
      const searchResult = appendSaleSearchFilter(where, searchTerm)
      if (searchResult.kind === 'tooShort') {
        return res.json({
          items: [],
          page: 1,
          pageSize,
          totalPages: 1,
          totalItems: 0,
          nextPage: null,
          prevPage: null,
          hasMore: false,
          searchMeta: {
            tooShort: true,
            minLength: searchResult.minLength ?? MIN_TEXT_SEARCH_LEN,
          },
        })
      }
      if (searchResult.kind === 'ok') {
        searchMeta = { mode: searchResult.parsedKind }
      }
    }

    if (customerContactId) {
      if (!req.user) {
        return res.status(401).json({ message: 'No autenticado' })
      }
      if (!userHasPerm(req.user, 'sales.view')) {
        return res.status(403).json({ message: 'No autorizado' })
      }
      try {
        assertPartyAction(req.user, PARTY.CUSTOMER, 'view')
      } catch (err) {
        return res.status(err.statusCode || 403).json({ message: err.message })
      }
      const contact = await prisma.supplier.findFirst({
        where: {
          id: String(customerContactId),
          deleted: false,
          party_type: 'CUSTOMER',
        },
        select: { id: true, name: true, tax_id: true },
      })
      if (!contact) {
        return res.status(404).json({ message: 'Cliente no encontrado' })
      }
      const nameTrim = String(contact.name || '').trim()
      const orClauses = [{ customer_contact_id: contact.id }]
      if (nameTrim) {
        orClauses.push({ customer: { equals: nameTrim, mode: 'insensitive' } })
      }
      const tid = contact.tax_id != null ? String(contact.tax_id).trim() : ''
      if (tid) {
        orClauses.push({ customer_nit: { equals: tid, mode: 'insensitive' } })
      }
      // Siempre hay al menos customer_contact_id en orClauses
      const prevAnd = Array.isArray(where.AND) ? where.AND : []
      where.AND = [...prevAnd, { OR: orClauses }]
    }

    /** Solo ventas «Completada»: total neto (adjusted_total) y última fecha — para resumen en ficha de cliente */
    let customerPurchaseSummary = null
    if (customerContactId) {
      const completedWhere = { ...where, status: { name: 'Completada' } }
      const [sumRes, lastSale] = await Promise.all([
        prisma.sale.aggregate({
          where: completedWhere,
          _sum: { adjusted_total: true },
        }),
        prisma.sale.findFirst({
          where: completedWhere,
          orderBy: { date: 'desc' },
          select: { date: true },
        }),
      ])
      customerPurchaseSummary = {
        totalPurchases: Number(sumRes._sum.adjusted_total ?? 0),
        lastSaleDate: lastSale?.date ? lastSale.date.toISOString() : null,
      }
    }

    const isGlobalSearch = Boolean(searchTerm)

    let totalItems
    let totalPages
    let safePage = page
    let hasMore = false
    let items

    if (isGlobalSearch) {
      // Sin COUNT(*) en búsqueda global: pedimos una fila extra para saber si hay más páginas
      const rows = await prisma.sale.findMany({
        where,
        include: SALE_LIST_INCLUDE,
        orderBy: { date: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize + 1,
      })
      hasMore = rows.length > pageSize
      items = rows.slice(0, pageSize)
      totalItems = null
      totalPages = null
      safePage = page
    } else {
      totalItems = await prisma.sale.count({ where })
      totalPages = Math.max(1, Math.ceil(totalItems / pageSize))
      safePage = Math.min(page, totalPages)

      items = await prisma.sale.findMany({
        where,
        include: SALE_LIST_INCLUDE,
        orderBy: { date: 'desc' },
        skip: (safePage - 1) * pageSize,
        take: pageSize,
      })
    }

    const nextPage = isGlobalSearch
      ? (hasMore ? safePage + 1 : null)
      : (safePage < totalPages ? safePage + 1 : null)
    const prevPage = safePage > 1 ? safePage - 1 : null

    res.json({
      items,
      page: safePage,
      pageSize,
      totalPages,
      totalItems,
      nextPage,
      prevPage,
      hasMore: isGlobalSearch ? hasMore : safePage < totalPages,
      ...(searchMeta ? { searchMeta } : {}),
      ...(customerPurchaseSummary != null ? { customerPurchaseSummary } : {}),
    })
  } catch (e) { next(e) }
}

// Acepta UUID o referencia legible (ej. V-000001, V-00000A)
const saleWhereIdOrReference = (idOrRef) => {
  if (!idOrRef) return { id: '' }
  const s = String(idOrRef).trim()
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)
  if (isUuid) return { id: s }
  return { reference: s }
}

exports.getById = async (req, res, next) => {
  try {
    const { id: idOrRef } = req.params
    // Lectura a nivel empresa: una venta de otra sucursal de la misma empresa
    // se puede consultar (p. ej. escanear un recibo), de otra empresa no.
    const where = {
      ...saleWhereIdOrReference(idOrRef),
      branch: { company_id: req.companyId },
    }

    const sale = await prisma.sale.findFirst({
      where,
      include: SALE_DETAIL_INCLUDE
    })

    if (!sale) {
      return res.status(404).json({ message: 'Venta no encontrada' })
    }

    res.json(sale)
  } catch (e) {
    next(e)
  }
}

exports.create = async (req, res, next) => {
  try {
    const user = req.user
    if (!user || !user.sub) {
      return res.status(401).json({ message: 'Usuario no autenticado' })
    }
    const {
      items,
      admin_authorized_products = [],
      promotion_codes = [],
      customer_contact_id: customerContactIdRaw,
      sales_channel: salesChannelRaw,
      idempotency_key: idempotencyKeyRaw,
      ...saleData
    } = req.body
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: 'items es requerido' })
    }

    // Clave del intento de cobro: la manda el POS (cabecera o cuerpo) y se
    // repite tal cual al reintentar. Sin ella todo funciona como antes.
    const idempotencyKey = String(req.get?.('Idempotency-Key') || idempotencyKeyRaw || '')
      .trim().slice(0, 64) || null

    const totalItems = items.reduce((acc, it) => acc + Number(it.qty || 0), 0)

    const schRaw = salesChannelRaw != null ? String(salesChannelRaw).toUpperCase() : 'POS'
    const salesChannel = VALID_CHANNELS.has(schRaw) ? schRaw : 'POS'
    let customerContactId = null
    if (customerContactIdRaw != null && String(customerContactIdRaw).trim() !== '') {
      customerContactId = String(customerContactIdRaw).trim()
    }

    // Convertir admin_authorized_products a Set para búsqueda rápida
    const adminAuthorizedSet = new Set(admin_authorized_products || [])

    const branchId = requireBranch(req)

    // El reintento evidente: la venta anterior ya entró y el navegador volvió a
    // mandar. La carrera (dos envíos a la vez) la corta el índice único, más
    // abajo.
    if (idempotencyKey) {
      const yaExiste = await prisma.sale.findFirst({
        where: { branch_id: branchId, idempotency_key: idempotencyKey },
        include: SALE_DETAIL_INCLUDE,
      })
      if (yaExiste) return res.status(200).json(yaExiste)
    }

    const created = await prismaTransaction.$transaction(async (tx) => {
      let cashSessionIdForSale = null
      const isAdmin = String(user.role?.name || user.role_name || '').toLowerCase() === 'admin'
      const branch = await tx.branch.findUnique({
        where: { id: branchId },
        select: { id: true, code: true, seq: true },
      })
      // Resolver la caja: la seleccionada en el POS > la asignada al usuario > la predeterminada.
      // Antes se usaba siempre la predeterminada, así que abrir turno en otra caja no contaba.
      const register = await resolveSaleRegister(tx, saleData.cash_register_id, user.sub, branchId)
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
        // El turno abierto en la caja resuelta (predeterminada o asignada) no es
        // automáticamente "mío": si lo abrió otra persona, un no-admin no puede
        // vender con él encima — antes se colaba porque solo se miraba la caja,
        // nunca de quién era el turno.
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

      // 1) Validación de stock: no permitir solicitar más que el stock disponible por producto
      // EXCEPTO para productos autorizados por administrador
      const qtyByProduct = new Map()
      for (const it of items) {
        const pid = String(it.product_id)
        const q = Number(it.qty || 0)
        if (!pid || !Number.isFinite(q) || q <= 0) {
          const err = new Error('Cada item debe incluir product_id y qty > 0')
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
          stock: true,
          category_id: true,
          price: true,
          price_wholesale: true,
          price_promotion: true,
          promotion_valid_until: true,
          available_for_sale: true,
          // Para congelar el costo en la línea de venta.
          cost: true,
        },
      })
      const prodMap = new Map(products.map(p => [String(p.id), p]))
      const availabilityMap = await getAvailabilityBatchWithKits(productIds, tx, branchId)
      // Verifica existencia y stock suficiente por producto (considera cantidades sumadas si hay repetidos)
      for (const pid of productIds) {
        const p = prodMap.get(pid)
        if (!p) {
          const err = new Error(`Producto no encontrado o eliminado: ${pid}`)
          err.status = 400
          throw err
        }

        if (!p.available_for_sale) {
          const err = new Error(`Producto no disponible para la venta: ${p.name}`)
          err.status = 400
          throw err
        }

        // Omitir validación de stock si fue autorizado por administrador
        if (adminAuthorizedSet.has(pid)) {
          console.log(`[ADMIN AUTH] Omitiendo validación de stock para producto ${p.name} (ID: ${pid})`)
          continue
        }

        const requested = Number(qtyByProduct.get(pid) || 0)
        const availability = availabilityMap[pid]
        const available = Number(availability?.available ?? 0)
        if (requested > available) {
          const reserved = Number(availability?.reserved ?? 0)
          const physical = Number(availability?.stock ?? 0)
          const err = new Error(
            `Stock insuficiente para ${p.name}. Disponible: ${available}${reserved > 0 ? ` (${physical} físico − ${reserved} reservado)` : ''}, solicitado: ${requested}`
          )
          err.status = 400
          throw err
        }
      }

      if (customerContactId) {
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

      const priceTier = await resolvePriceTierForContext(tx, {
        customerContactId,
        salesChannel,
      })
      const priceNow = new Date()
      const resolvedItems = items.map((it) => {
        const p = prodMap.get(String(it.product_id))
        const unit = resolveUnitPriceFromProduct(p, priceTier, priceNow)
        return { ...it, price: unit }
      })
      const subtotal = resolvedItems.reduce(
        (acc, it) => acc + Number(it.price || 0) * Number(it.qty || 0),
        0
      )

      // 2) Procesar códigos de promoción
      let discountTotal = 0
      /** Fila por promo aplicada con descuento > 0 (para sale_promotions + incremento de usos) */
      let promotionRowsToRecord = []

      const requestedCodes = [
        ...new Set(
          (promotion_codes || [])
            .map((c) => String(c || '').toUpperCase().trim())
            .filter(Boolean)
        ),
      ]

      if (requestedCodes.length > 0) {
        const rawMax = process.env.MAX_PROMOTION_CODES_PER_SALE
        let maxPromoCodes = Infinity
        if (rawMax !== undefined && rawMax !== '') {
          const n = parseInt(String(rawMax), 10)
          if (Number.isFinite(n) && n >= 1) maxPromoCodes = n
        }
        if (requestedCodes.length > maxPromoCodes) {
          const err = new Error(
            maxPromoCodes === 1
              ? 'Solo se permite un código de promoción por venta'
              : `Máximo ${maxPromoCodes} códigos de promoción por venta`
          )
          err.status = 400
          throw err
        }

        const { applyMultiplePromotions } = require('../services/promotionCalculator')
        const now = new Date()

        const itemsWithCategory = resolvedItems.map((it) => ({
          ...it,
          category_id: prodMap.get(String(it.product_id))?.category_id,
        }))

        const promotionCodeRows = await tx.promotionCode.findMany({
          where: {
            code: { in: requestedCodes },
            company_id: req.companyId,
            active: true,
            promotion: {
              active: true,
              deleted: false,
              // Un código de otra sucursal no se puede cobrar aquí
              OR: [
                { applies_to_all_branches: true },
                { branches: { some: { branch_id: branchId } } },
              ],
            },
          },
          include: {
            promotion: {
              include: {
                type: true,
                applicable_products: true,
                applicable_categories: true,
              },
            },
          },
        })

        const byCode = new Map(
          promotionCodeRows.map((row) => [String(row.code).toUpperCase(), row])
        )

        for (const code of requestedCodes) {
          if (!byCode.has(code)) {
            const err = new Error(`Código de promoción no válido o inactivo: ${code}`)
            err.status = 400
            throw err
          }
        }

        const candidatePromotions = []
        const seenPromotionIds = new Set()
        for (const code of requestedCodes) {
          const promoCodeRow = byCode.get(code)
          const promo = promoCodeRow.promotion
          promo.usedCode = promoCodeRow.code
          promo.usedCodeId = promoCodeRow.id

          if (seenPromotionIds.has(promo.id)) {
            const err = new Error(
              'No se pueden aplicar dos códigos de la misma promoción en una sola venta'
            )
            err.status = 400
            throw err
          }
          seenPromotionIds.add(promo.id)

          if (promo.start_date && now < promo.start_date) {
            const err = new Error(`El código ${code} aún no está vigente`)
            err.status = 400
            throw err
          }
          if (promo.end_date && now > promo.end_date) {
            const err = new Error(`El código ${code} ha expirado`)
            err.status = 400
            throw err
          }
          if (promo.max_uses && promoCodeRow.current_uses >= promo.max_uses) {
            const err = new Error(`El código ${code} alcanzó su límite de usos`)
            err.status = 400
            throw err
          }

          candidatePromotions.push(promo)
        }

        const multiResult = applyMultiplePromotions(candidatePromotions, itemsWithCategory)

        const needsGiftInCart = (multiResult.freeGifts || []).some(
          (fg) => fg && fg.mustAddToCart === true
        )
        if (needsGiftInCart) {
          const err = new Error(
            'Un código de promoción requiere el producto regalo en el carrito. Agréguelo y vuelva a intentar.'
          )
          err.status = 400
          throw err
        }

        discountTotal = multiResult.totalDiscount
        promotionRowsToRecord = multiResult.appliedPromotions || []

        if (discountTotal <= 0) {
          const err = new Error(
            'Los códigos de promoción no aplican descuento con los productos actuales del carrito'
          )
          err.status = 400
          throw err
        }
      }

      // Calcular total final
      const total = Math.max(0, subtotal - discountTotal)

      // Nueva venta se registra directamente como Completada (sin estados Pagado/Pendiente)
      const completadaStatus = await tx.saleStatus.findFirst({ where: { name: 'Completada' } })
      if (!completadaStatus) throw new Error("No existe el estado 'Completada'")

      // Instante real de la venta, en UTC de verdad. Antes esto "truqueaba" a
      // Postgres guardando la hora de Guatemala reetiquetada como UTC — corría
      // el dato guardado el offset de la zona (6h). La pantalla convierte a la
      // zona configurada al mostrarlo; acá no hay que convertir nada.
      const saleDate = new Date()

      // ---- Venta al crédito (cuentas por cobrar) ----
      // Con un método marcado is_credit no entra dinero: queda un saldo por
      // cobrar a nombre del cliente, con vencimiento y sujeto a su límite.
      const paymentMethod = await tx.paymentMethod.findUnique({
        where: { id: Number(saleData.payment_method_id) },
        select: { id: true, name: true, is_credit: true },
      })
      if (!paymentMethod) {
        const err = new Error('Método de pago inválido')
        err.status = 400
        throw err
      }
      let creditDueDate = null
      let salePaymentStatus = 'PAID'
      if (paymentMethod.is_credit) {
        if (!customerContactId) {
          const err = new Error('Una venta al crédito requiere elegir al cliente')
          err.status = 400
          throw err
        }
        const customer = await tx.supplier.findFirst({
          where: { id: customerContactId, company_id: req.companyId },
          select: {
            id: true, name: true, credit_limit: true,
            supplier_payment_terms: {
              where: { is_default: true },
              select: { payment_term: { select: { net_days: true } } },
              take: 1,
            },
          },
        })
        if (!customer) {
          const err = new Error('Cliente no encontrado')
          err.status = 404
          throw err
        }

        // Vencimiento: el que mande el POS, o el plazo por defecto del cliente.
        if (saleData.due_date != null && String(saleData.due_date).trim() !== '') {
          const d = new Date(saleData.due_date)
          if (Number.isNaN(d.getTime())) {
            const err = new Error('La fecha de vencimiento es inválida')
            err.status = 400
            throw err
          }
          creditDueDate = d
        } else {
          const netDays = customer.supplier_payment_terms[0]?.payment_term?.net_days
          if (netDays != null) {
            creditDueDate = new Date(saleDate.getTime() + Number(netDays) * 86400000)
          }
        }

        // Sin esto dos cajeros vendiéndole al mismo cliente a la vez leen el
        // mismo saldo y ambos pasan el límite. Se libera al commitear.
        await lockCustomer(tx, customer.id)
        const check = await checkCredit(tx, customer, total, { branch_id: branchId })
        if (!check.ok) {
          // Quien tenga el permiso puede pasarla igual, pero explícitamente:
          // el override viaja en el cuerpo, no se asume por tener el permiso.
          const authorized = saleData.credit_override === true && hasPerm(user, 'sales.credit.override')
          if (!authorized) {
            const err = new Error(check.motivo || 'El cliente no puede llevar esta venta al crédito')
            err.status = 409
            err.details = { ...check, requiere_permiso: 'sales.credit.override' }
            throw err
          }
        }
        salePaymentStatus = 'PENDING'
      }

      const nextRef = await nextDocumentReference(tx, 'V', branch)

      const sale = await tx.sale.create({
        data: {
          branch_id: branchId,
          customer: saleData.customer,
          customer_nit: saleData.customer_nit,
          is_final_consumer: saleData.is_final_consumer,
          payment_method_id: saleData.payment_method_id,
          amount_received: saleData.amount_received,
          change: saleData.change,
          customer_contact_id: customerContactId || undefined,
          sales_channel: salesChannel,
          reference: nextRef,
          date: saleDate,
          sold_at: saleDate,  // Establecer sold_at explícitamente en hora de Guatemala
          items: totalItems,
          subtotal,
          discount_total: discountTotal > 0 ? discountTotal : null,
          total,
          total_returned: 0,  // Nueva venta sin devoluciones
          adjusted_total: total,  // Total ajustado = total (sin devoluciones aún)
          status_id: completadaStatus.id,
          created_by: user.sub,
          cash_register_session_id: cashSessionIdForSale || undefined,
          idempotency_key: idempotencyKey,
          payment_status: salePaymentStatus,
          due_date: creditDueDate,
        },
      })

      await tx.saleItem.createMany({
        // El costo se congela acá: es el de hoy, no el que tenga el producto
        // cuando alguien contabilice o mire el reporte dentro de seis meses.
        data: resolvedItems.map(it => ({
          sale_id: sale.id,
          product_id: it.product_id,
          price: it.price,
          unit_cost: prodMap.get(String(it.product_id))?.cost ?? null,
          qty: it.qty,
        })),
      })

      // Descontar stock (kits → componentes)
      const stockMap = await expandLinesToStockMap(
        tx,
        resolvedItems.map((it) => ({ product_id: it.product_id, qty: it.qty }))
      )
      // groupId propio: una venta puede descontar stock más de una vez a lo largo
      // de su vida (completar → cancelar → completar), y los lotes solo deben
      // seguir a la salida de ahora.
      const saleStockCtx = {
        reason: 'SALE', refType: 'sale', refId: String(sale.id), userId: user.sub,
        groupId: require('crypto').randomUUID(),
      }
      const updatedProducts = await deductStockMap(tx, stockMap, branchId, saleStockCtx)
      // Advisory: descuenta lotes por caducidad, dentro de la ubicación que despachó.
      await consumeLotsFEFO(tx, stockMap, branchId, await dispatchedByRef(tx, { groupId: saleStockCtx.groupId }))
      await ensureStockAlertsBatch(tx, updatedProducts, branchId)

      // 3) Guardar promociones con descuento efectivo e incrementar solo esos códigos
      if (promotionRowsToRecord.length > 0) {
        for (const row of promotionRowsToRecord) {
          await tx.salePromotion.create({
            data: {
              sale_id: sale.id,
              promotion_id: row.promotionId,
              discount_applied: row.discount,
              code_used: row.usedCode || null,
            },
          })

          if (row.usedCodeId) {
            // Incremento condicional en una sola consulta. Leer, comparar y
            // sumar (que es lo que valida arriba) deja pasar dos ventas
            // simultáneas con el último uso disponible: ambas leen el mismo
            // valor y ambas incrementan. Cero filas = el límite ya se alcanzó.
            const aplicados = await tx.$executeRaw`
              UPDATE promotion_codes pc
              SET current_uses = pc.current_uses + 1
              FROM promotions p
              WHERE pc.id = ${row.usedCodeId}
                AND p.id = pc.promotion_id
                AND (p.max_uses IS NULL OR pc.current_uses < p.max_uses)
            `
            if (aplicados === 0) {
              const err = new Error(`El código ${row.usedCode || ''} alcanzó su límite de usos`.trim())
              err.status = 400
              throw err
            }
          }
        }
      }

      return sale
    }, {
      timeout: 20000,
      maxWait: 10000
    })

    const fullSale = await prisma.sale.findFirst({
      where: { id: created.id },
      include: SALE_DETAIL_INCLUDE
    })

    res.status(201).json(fullSale || created)
  } catch (e) {
    // Dos envíos a la vez con la misma clave: uno gana el índice único y el
    // otro devuelve la venta que quedó, no un error al cajero.
    if (e && e.code === 'P2002' && String(e.meta?.target || '').includes('idempotency')) {
      const branchId = req.branchId
      const key = String(req.get?.('Idempotency-Key') || req.body?.idempotency_key || '').trim().slice(0, 64)
      const yaExiste = key && branchId
        ? await prisma.sale.findFirst({
            where: { branch_id: branchId, idempotency_key: key },
            include: SALE_DETAIL_INCLUDE,
          })
        : null
      if (yaExiste) return res.status(200).json(yaExiste)
    }
    if (e && e.message === 'CASH_SESSION_REQUIRED') {
      return res.status(403).json({
        code: 'CASH_SESSION_REQUIRED',
        message: 'Debe abrir la caja (turno) antes de registrar ventas.'
      })
    }
    if (e && e.message === 'CASH_SESSION_OTHER_USER') {
      return res.status(403).json({
        code: 'CASH_SESSION_OTHER_USER',
        message: `Esta caja ya tiene un turno abierto por ${e.openedByName}. Debe cerrar ese turno o utilizar una caja asignada.`
      })
    }
    if (e && e.message === 'NO_CASH_REGISTER') {
      return res.status(503).json({
        code: 'NO_CASH_REGISTER',
        message: 'No hay caja configurada. Ejecute migraciones y seed.'
      })
    }
    next(e)
  }
}

// PATCH /sales/:id/status  { status_name?: string, status_id?: number }

exports.updateStatus = async (req, res, next) => {
  try {
    const { id } = req.params
    const { status_name, status_id } = req.body || {}

    if (!id) return res.status(400).json({ message: 'id requerido' })
    if (!status_name && !status_id) {
      return res.status(400).json({ message: 'Debe enviar status_name o status_id' })
    }

    let targetStatusId = status_id
    if (status_name) {
      const st = await prisma.saleStatus.findFirst({ where: { name: String(status_name) } })
      if (!st) return res.status(400).json({ message: 'Estado no encontrado: ' + status_name })
      targetStatusId = st.id
    }

    if (!targetStatusId) return res.status(400).json({ message: 'status_id inválido' })

    const where = saleWhereIdOrReference(id)

    // Usar limitador de concurrencia para evitar sobrecarga
    const result = await salesOperationLimiter.run(async () => {
      return await prismaTransaction.$transaction(async (tx) => {
        // Cargar venta actual con su status e items (por id o por reference)
        const current = await tx.sale.findFirst({
          where: { ...where, branch: { company_id: req.companyId } },
          // Las devoluciones ya devolvieron su parte del stock: sin ellas a la
          // vista, cancelar devolvía la venta completa y duplicaba lo devuelto.
          include: {
            status: true,
            sale_items: { include: { return_items: { select: { qty_returned: true } } } },
            cashRegisterSession: { select: { status: true } },
          },
        })
        if (!current) throw new Error('Venta no encontrada')

        // El cierre guardó el teórico recorriendo las ventas del turno. Cambiar
        // una de ellas después deja la diferencia contra el conteo físico sin
        // explicación posible. La devolución sí se permite: es un movimiento
        // nuevo, con su fecha, que no reescribe el arqueo de ayer.
        if (current.cashRegisterSession?.status === 'CLOSED') {
          const err = new Error(
            `La venta ${current.reference || ''} pertenece a un turno de caja ya cerrado y no se puede cambiar de estado. `.trim() +
            'Registre una devolución en el turno actual.'
          )
          err.status = 409
          err.code = 'CASH_SESSION_CLOSED'
          throw err
        }
        // El stock se ajusta en la sucursal DONDE SE VENDIÓ, no en la del request
        const saleBranchId = current.branch_id

        const prevStatusName = current.status?.name || ''
        // Obtener nombre del nuevo status para comparar lógicamente
        const newStatus = await tx.saleStatus.findUnique({ where: { id: targetStatusId } })
        if (!newStatus) throw new Error('Estado destino inválido')
        const newStatusName = newStatus.name

        const wasCompleted = prevStatusName === 'Completada'
        const willBeCompleted = newStatusName === 'Completada'
        const willBeCancelled = newStatusName === 'Cancelada'

        // Transición: otro -> Completada => descontar stock
        if (!wasCompleted && willBeCompleted) {
          console.log(`[STOCK ADJUSTMENT] Venta ${id}: ${prevStatusName} -> Completada. Descontando stock...`)

          const stockMap = await expandLinesToStockMap(
            tx,
            current.sale_items.map((si) => ({ product_id: si.product_id, qty: si.qty }))
          )
          const stockCtx = {
            // `id` es lo que mandó el cliente: puede ser la referencia legible
            // (V-MIXCO-000005), no el UUID. ref_id es una columna uuid — hay
            // que usar el id real de la fila ya resuelta.
            reason: 'SALE', refType: 'sale', refId: String(current.id), userId: req.user?.sub || null,
            groupId: require('crypto').randomUUID(),
          }
          const updatedProducts = await deductStockMap(tx, stockMap, saleBranchId, stockCtx)
          // Advisory: descuenta lotes por caducidad, dentro de la ubicación que despachó.
          await consumeLotsFEFO(tx, stockMap, saleBranchId, await dispatchedByRef(tx, { groupId: stockCtx.groupId }))

          updatedProducts.forEach(p => {
            console.log(`[STOCK ADJUSTMENT] ${p.name}: nuevo stock = ${p.stock}`)
          })

          // Procesar alertas en lote (mucho más eficiente)
          await ensureStockAlertsBatch(tx, updatedProducts, saleBranchId)
          console.log(`[STOCK ADJUSTMENT] Alertas de stock actualizadas`)
        }

        // Transición: Completada -> Cancelada => REVERTIR todos los ajustes de stock
        if (wasCompleted && willBeCancelled) {
          console.log(`[STOCK REVERT] Venta ${id}: Completada -> Cancelada. Revirtiendo ajustes de stock...`)

          // Solo se devuelve lo que el cliente todavía tiene: lo ya devuelto
          // volvió al inventario cuando se aprobó la devolución.
          const porDevolver = current.sale_items
            .map((si) => {
              const devuelto = (si.return_items || []).reduce((n, r) => n + Number(r.qty_returned || 0), 0)
              return { product_id: si.product_id, qty: Math.max(0, Number(si.qty) - devuelto) }
            })
            .filter((l) => l.qty > 0)
          const stockMap = await expandLinesToStockMap(tx, porDevolver)
          const updatedProducts = await restoreStockMap(tx, stockMap, saleBranchId, {
            reason: 'SALE_RETURN', refType: 'sale', refId: String(current.id), userId: req.user?.sub || null,
          })
          await restoreLotsFEFO(tx, stockMap, saleBranchId) // devuelve cantidad a los lotes

          updatedProducts.forEach(p => {
            console.log(`[STOCK REVERT] ${p.name}: stock restaurado = ${p.stock}`)
          })

          // Actualizar alertas de stock (puede resolver alertas si el stock volvió a niveles normales)
          await ensureStockAlertsBatch(tx, updatedProducts, saleBranchId)
          console.log(`[STOCK REVERT] Alertas de stock actualizadas después de reversión`)
        }

        // Actualizar estado de la venta (siempre por id interno)
        const updated = await tx.sale.update({
          where: { id: current.id },
          data: { status_id: targetStatusId },
          include: { payment_method: true, status: true }
        })

        // Determinar tipo de ajuste realizado
        let stockAdjustment = 'none'
        if (!wasCompleted && willBeCompleted) {
          stockAdjustment = 'stock_decremented' // Se descontó stock al completar
        } else if (wasCompleted && willBeCancelled) {
          stockAdjustment = 'stock_reverted' // Se revirtió stock al cancelar desde completada
        }

        return {
          ...updated,
          _stockAdjustment: stockAdjustment,
          _transition: `${prevStatusName} -> ${newStatusName}`
        }
      }, {
        maxWait: 10000, // Aumentar el tiempo máximo de espera a 10 segundos
        timeout: 15000, // Aumentar el timeout a 15 segundos
      })
    }) // Cierre del salesOperationLimiter.run

    res.json(result)
  } catch (e) { next(e) }
}
