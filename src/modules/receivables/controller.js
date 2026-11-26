/**
 * Copyright (c) 2026 Diego Patzán. All Rights Reserved.
 *
 * This source code is licensed under a Proprietary License.
 * Unauthorized copying, modification, distribution, or use of this file,
 * via any medium, is strictly prohibited without express written permission.
 *
 * For licensing inquiries: GitHub @dpatzan2
 */

/**
 * Cartera (cuentas por cobrar): saldo por cliente, estado de cuenta,
 * antigüedad de saldos y registro de cobros.
 */

const { Prisma } = require('@prisma/client')
const { DateTime } = require('luxon')
const { getTimezone } = require('../../utils/getTimezone')
const { creditDueDate } = require('../../services/commercialPayment')
const { prisma, prismaTransaction } = require('../../models/prisma')
const { resolvePaymentMethod } = require('../../services/paymentMethods/access')
const { requireCompany, requireBranch, hasPerm } = require('../../middlewares/tenant')
const { round2 } = require('../../services/accounting/logic')
const {allocationForReceipt,allocationSelect,hydrateReceiptAllocations}=require('./domain/paymentAllocations')
const {
  ROUND_EPS,
  ReceivableError,
  balanceOf,
  applyPayment,
  applyAvailableCredit,
  syncSaleStatus,
  customerBalance,
  unappliedPayments,
  checkCredit,
  agingBucket,
  lockCustomer,
  CUSTOMER_TERM_PICK,
} = require('./domain/receivables')

/** Ajustes que bajan la deuda sin que entre dinero. */
const ADJUSTMENT_KINDS = ['CREDIT_NOTE', 'WRITE_OFF']

const PAYMENT_TX_OPTIONS = { timeout: 30000, maxWait: 10000 }

function fail(status, message, details) {
  throw new ReceivableError(message, status, details)
}

/** Sucursales del request: la activa, o todas las de la empresa en consolidada. */
function branchIdsOf(req) {
  const ids = req.branchId ? [req.branchId] : req.branchIds || []
  if (!ids.length) fail(400, 'Esta operación requiere una sucursal')
  return ids
}

/** Where de sucursal para consultas Prisma. */
function branchFilter(req) {
  const ids = branchIdsOf(req)
  return ids.length === 1 ? { branch_id: ids[0] } : { branch_id: { in: ids } }
}

function number(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/** Facturas abiertas: búsqueda y paginación sin descargar toda la cartera. */
exports.invoices = async (req, res, next) => {
  try {
    const companyId = requireCompany(req)
    const q = req.query || {}
    const page = Math.max(1, Math.trunc(number(q.page) || 1))
    const pageSize = Math.min(100, Math.max(1, Math.trunc(number(q.pageSize) || 10)))
    const state = String(q.state || 'ALL')
    if (!['ALL', 'OVERDUE', 'UPCOMING', 'PARTIAL'].includes(state)) fail(400, 'Estado de cartera inválido')
    const now = new Date()
    const where = {
      ...branchFilter(req), customer_contact_id: { not: null },
      customerContact: { company_id: companyId },
      payment_status: state === 'PARTIAL' ? 'PARTIAL' : { in: ['PENDING', 'PARTIAL'] },
      payment_method: { is_credit: true }, status: { name: 'Completada' },
    }
    if (q.customer_id) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(q.customer_id))) fail(400, 'Cliente inválido')
      where.customer_contact_id = String(q.customer_id)
    }
    if (state === 'OVERDUE') where.due_date = { lt: now }
    if (state === 'UPCOMING') where.due_date = { gte: now, lte: new Date(now.getTime() + 30 * 86400000) }
    const term = String(q.search || '').trim().slice(0, 200)
    if (term) where.OR = [
      { reference: { contains: term, mode: 'insensitive' } },
      { customerContact: { name: { contains: term, mode: 'insensitive' } } },
    ]
    if (q.date_from || q.date_to) {
      const timezone = await getTimezone(prisma, companyId)
      where.date = {}
      for (const [key, field] of [['date_from', 'gte'], ['date_to', 'lt']]) {
        if (!q[key]) continue
        const input = String(q[key])
        const day = DateTime.fromISO(input, { zone: timezone })
        if (!/^\d{4}-\d{2}-\d{2}$/.test(input) || !day.isValid) fail(400, 'Fecha inválida')
        where.date[field] = (field === 'lt' ? day.plus({ days: 1 }) : day).startOf('day').toJSDate()
      }
      if (q.date_from && q.date_to && String(q.date_from) > String(q.date_to)) fail(400, 'Rango de fechas inválido')
    }
    // Los cargos por contracargo comparten esta lista de documentos abiertos, ordenados por vencimiento.
    // ponytail: mezcla en memoria hasta la página pedida; con miles de cargos abiertos conviene una consulta UNION paginada.
    const saleCount = await prisma.sale.count({ where })
    const firstPass = await require('./domain/chargeDocuments').chargeInvoices(prisma, companyId, { branchIds: branchIdsOf(req), state, customerId: q.customer_id ? String(q.customer_id) : null, term,
      from: where.date?.gte ?? null, to: where.date?.lt ?? null, now, take: page * pageSize })
    const totalItems = saleCount + firstPass.total
    const totalPages = Math.max(1, Math.ceil(totalItems / pageSize))
    const safePage = Math.min(page, totalPages)
    // Sin cargos abiertos se pagina en la base como siempre; con cargos se mezclan hasta la página pedida.
    const merged = firstPass.total > 0
    const sales = await prisma.sale.findMany({
      where, ...(merged ? { take: safePage * pageSize } : { skip: (safePage - 1) * pageSize, take: pageSize }),
      orderBy: [{ due_date: 'asc' }, { date: 'asc' }, { id: 'asc' }],
      select: { id: true, reference: true, date: true, due_date: true, adjusted_total: true,
        payment_status: true, customerContact: { select: { id: true, name: true } },
        paymentEntries: { select: { amount: true } } },
    })
    const saleRows = sales.map((s) => ({
      id: s.id, reference: s.reference, date: s.date, due_date: s.due_date,
      total: round2(number(s.adjusted_total)), abonado: round2(number(s.adjusted_total) - balanceOf(s)),
      saldo: balanceOf(s), payment_status: s.payment_status,
      customer_id: s.customerContact.id, customer_name: s.customerContact.name,
      vencida: Boolean(s.due_date && s.due_date < now),
      dias_vencida: s.due_date ? Math.max(0, Math.floor((now - s.due_date) / 86400000)) : 0,
    }))
    const due = row => new Date(row.due_date || row.date).getTime()
    const items = merged ? [...saleRows, ...firstPass.items].sort((a, b) => due(a) - due(b) || new Date(a.date) - new Date(b.date) || String(a.id).localeCompare(String(b.id)))
      .slice((safePage - 1) * pageSize, safePage * pageSize) : saleRows
    res.json({ page: safePage, pageSize, totalItems, totalPages, items })
  } catch (e) { next(e) }
}

/**
 * GET /api/receivables
 * Cartera: un renglón por cliente con saldo pendiente.
 *
 * Se agrega en la base y no en memoria: con miles de facturas abiertas traerlas
 * todas para sumarlas en JS es el mismo error que ya se corrigió en el motor de
 * posteo.
 */
exports.list = async (req, res, next) => {
  try {
    requireCompany(req)
    const ids = branchIdsOf(req)
    const branchIn = Prisma.join(ids.map((i) => Prisma.sql`${i}::uuid`))
    const disputes=await require('../cash-closure/disputes.queries').disputesAvailable(prisma)
    const held=disputes?Prisma.sql`coalesce((SELECT sum(held) FROM customer_receipt_restrictions WHERE payment_id=cp.id),0)`:Prisma.sql`0`
    const retired=disputes?Prisma.sql`coalesce((SELECT sum(retired) FROM customer_receipt_restrictions WHERE payment_id=cp.id),0)`:Prisma.sql`0`
    const chargeApplied=disputes?Prisma.sql`coalesce((SELECT sum(CASE action WHEN 'APPLY' THEN amount ELSE -amount END) FROM customer_dispute_charge_applications WHERE payment_id=cp.id),0)`:Prisma.sql`0`
    const refunded=disputes?Prisma.sql`cash_dispute_receipt_refunded(cp.id)`:Prisma.sql`COALESCE(rf.refunded,0)`
    // El FULL OUTER JOIN existe para que un cliente que solo tiene anticipo (pagó
    // por adelantado y no debe nada) siga apareciendo: con un JOIN normal
    // desaparecería y ese dinero no se vería en ninguna pantalla.
    const rows = await prisma.$queryRaw`
      WITH deuda AS (
        SELECT
          s.customer_contact_id AS cid,
          SUM(s.adjusted_total - COALESCE(p.paid, 0))                          AS saldo,
          SUM(CASE WHEN s.due_date IS NOT NULL AND s.due_date < NOW()
                   THEN s.adjusted_total - COALESCE(p.paid, 0) ELSE 0 END)     AS vencido,
          COUNT(*)                                                             AS facturas,
          MIN(s.due_date)                                                      AS vence_primero
        FROM sales s
        JOIN sale_statuses st    ON st.id = s.status_id
        JOIN payment_methods pm  ON pm.id = s.payment_method_id
        LEFT JOIN (
          SELECT sale_id, SUM(amount) AS paid FROM sale_payment_entries GROUP BY sale_id
        ) p ON p.sale_id = s.id
        WHERE pm.is_credit
          AND st.name = 'Completada'
          AND s.payment_status IN ('PENDING', 'PARTIAL')
          AND s.customer_contact_id IS NOT NULL
          AND s.branch_id IN (${branchIn})
        GROUP BY s.customer_contact_id
      ),
      credito AS (
        SELECT
          cp.customer_id AS cid,
          SUM(cp.amount - COALESCE(a.applied, 0) - COALESCE(pc.committed, 0) - ${refunded} - ${held} - ${retired} - ${chargeApplied}) AS credito,
          SUM(COALESCE(pc.committed,0)) AS comprometido,
          SUM(${held}) AS retenido
        FROM customer_payments cp
        LEFT JOIN (
          SELECT customer_payment_id, SUM(amount) AS applied
          FROM sale_payment_entries GROUP BY customer_payment_id
        ) a ON a.customer_payment_id = cp.id
        LEFT JOIN (SELECT payment_id,SUM(amount) AS committed FROM payment_commitments WHERE state='COMMITTED' GROUP BY payment_id) pc ON pc.payment_id=cp.id
        LEFT JOIN (SELECT payment_id,SUM(amount) AS refunded FROM (SELECT payment_id,amount FROM customer_payment_refunds WHERE status='CONFIRMED' UNION ALL SELECT payment_id,amount FROM payment_allocation_events WHERE action='SALE_REFUNDED') returned GROUP BY payment_id) rf ON rf.payment_id=cp.id
        WHERE cp.branch_id IN (${branchIn})
        GROUP BY cp.customer_id
      )
      SELECT
        sup.id::text                        AS customer_id,
        sup.name                            AS customer_name,
        sup.credit_limit                    AS credit_limit,
        COALESCE(d.saldo, 0)                AS saldo,
        COALESCE(d.vencido, 0)              AS vencido,
        COALESCE(d.facturas, 0)             AS facturas,
        d.vence_primero                     AS vence_primero,
        GREATEST(COALESCE(c.credito, 0), 0) AS credito
        ,COALESCE(c.comprometido,0) AS comprometido
        ,COALESCE(c.retenido,0) AS retenido
      FROM deuda d
      FULL OUTER JOIN credito c ON c.cid = d.cid
      JOIN suppliers sup ON sup.id = COALESCE(d.cid, c.cid)
      WHERE COALESCE(d.saldo, 0) > ${ROUND_EPS}
         OR COALESCE(c.credito, 0) > ${ROUND_EPS}
         OR COALESCE(c.comprometido,0) > ${ROUND_EPS}
         OR COALESCE(c.retenido,0) > ${ROUND_EPS}
      ORDER BY vencido DESC, saldo DESC
    `
    // Los cargos por contracargo son otro documento por cobrar: suman al saldo y al vencido sin contarse como factura.
    const Charges = require('./domain/chargeDocuments')
    const [charges, recoveries] = await Promise.all([Charges.chargeTotalsByCustomer(prisma, ids), Charges.recoveryCreditTotalsByCustomer(prisma, ids)])
    const missing = [...new Set([...charges.keys(), ...recoveries.keys()])].filter(id => !rows.some(r => r.customer_id === id))
    if (missing.length) rows.push(...(await prisma.supplier.findMany({ where: { id: { in: missing }, company_id: req.companyId }, select: { id: true, name: true, credit_limit: true } }))
      .map(c => ({ customer_id: c.id, customer_name: c.name, credit_limit: c.credit_limit, saldo: 0, vencido: 0, facturas: 0, vence_primero: null, credito: 0, comprometido: 0, retenido: 0 })))
    const items = rows.map((r) => {
      const cargo = charges.get(r.customer_id), recuperacion = recoveries.get(r.customer_id) || 0
      const saldo = round2(number(r.saldo) + (cargo?.saldo || 0))
      const credito = round2(number(r.credito))
      const firstCharge = cargo?.items.map(i => i.due_date).sort((a, b) => new Date(a) - new Date(b))[0]
      return {
        customer_id: r.customer_id,
        customer_name: r.customer_name,
        credito_comprometido:round2(number(r.comprometido)),
        credito_en_revision:round2(number(r.retenido)),
        credit_limit: r.credit_limit == null ? null : round2(number(r.credit_limit)),
        saldo,
        vencido: round2(number(r.vencido) + (cargo?.vencido || 0)),
        facturas: Number(r.facturas),
        cargos: cargo?.cargos || 0,
        cargos_vencidos: cargo?.vencidos || 0,
        documentos: Number(r.facturas) + (cargo?.cargos || 0),
        vence_primero: [r.vence_primero, firstCharge].filter(Boolean).sort((a, b) => new Date(a) - new Date(b))[0] ?? null,
        credito_disponible: credito,
        credito_recuperacion: recuperacion,
        saldo_neto: round2(Math.max(0, saldo - credito - recuperacion)),
      }
    }).filter(i => i.saldo > ROUND_EPS || i.credito_disponible > ROUND_EPS || i.credito_comprometido > ROUND_EPS || i.credito_en_revision > ROUND_EPS || i.credito_recuperacion > ROUND_EPS)
      .sort((a, b) => b.vencido - a.vencido || b.saldo - a.saldo)
    res.json({
      items,
      total_por_cobrar: round2(items.reduce((s, i) => s + i.saldo, 0)),
      total_vencido: round2(items.reduce((s, i) => s + i.vencido, 0)),
      total_credito: round2(items.reduce((s, i) => s + i.credito_disponible, 0)),
      total_credito_en_revision: round2(items.reduce((s, i) => s + i.credito_en_revision, 0)),
    })
  } catch (e) {
    next(e)
  }
}

/**
 * GET /api/receivables/aging
 * Antigüedad de saldos por cliente y por rango de días vencidos.
 */
exports.aging = async (req, res, next) => {
  try {
    requireCompany(req)
    const now = new Date()
    const open = await prisma.sale.findMany({
      where: {
        payment_status: { in: ['PENDING', 'PARTIAL'] },
        payment_method: { is_credit: true },
        status: { name: 'Completada' },
        customer_contact_id: { not: null },
        ...branchFilter(req),
      },
      select: {
        id: true, due_date: true, adjusted_total: true,
        customerContact: { select: { id: true, name: true } },
        paymentEntries: { select: { amount: true } },
      },
    })

    const porCliente = new Map()
    const totales = { corriente: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_mas: 0 }
    for (const sale of open) {
      const saldo = balanceOf(sale)
      if (saldo <= ROUND_EPS) continue
      const cid = sale.customerContact?.id
      if (!cid) continue
      if (!porCliente.has(cid)) {
        porCliente.set(cid, {
          customer_id: cid,
          customer_name: sale.customerContact.name,
          corriente: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_mas: 0, total: 0,
        })
      }
      const fila = porCliente.get(cid)
      const bucket = agingBucket(sale.due_date, now)
      fila[bucket] = round2(fila[bucket] + saldo)
      fila.total = round2(fila.total + saldo)
      totales[bucket] = round2(totales[bucket] + saldo)
    }

    const ids = branchIdsOf(req), charges = await require('./domain/chargeDocuments').chargeTotalsByCustomer(prisma, ids, now)
    if (charges.size) {
      const names = new Map((await prisma.supplier.findMany({ where: { id: { in: [...charges.keys()] }, company_id: req.companyId }, select: { id: true, name: true } })).map(c => [c.id, c.name]))
      for (const [cid, cargo] of charges) {
        if (!porCliente.has(cid)) porCliente.set(cid, { customer_id: cid, customer_name: names.get(cid) || '', corriente: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_mas: 0, total: 0 })
        const fila = porCliente.get(cid)
        // Un cargo vence al terminar su día: se mide desde el final de esa fecha.
        for (const item of cargo.items) { const bucket = agingBucket(new Date(new Date(item.due_date).getTime() + 86399999), now); fila[bucket] = round2(fila[bucket] + item.balance); fila.total = round2(fila.total + item.balance); totales[bucket] = round2(totales[bucket] + item.balance) }
      }
    }
    const items = [...porCliente.values()].sort((a, b) => b.total - a.total)
    res.json({
      items,
      totales: { ...totales, total: round2(items.reduce((s, i) => s + i.total, 0)) },
    })
  } catch (e) {
    next(e)
  }
}

/**
 * GET /api/receivables/overdue-count
 * Contador para el badge del módulo.
 *
 * No usa la tabla `alerts` a propósito: ese modelo es de stock (product_id es
 * obligatorio, con current_stock/min_stock), así que una factura vencida no
 * cabe ahí sin volver polimórfica una tabla que hoy es simple.
 */
exports.overdueCount = async (req, res, next) => {
  try {
    requireCompany(req)
    const now = new Date()
    const open = await prisma.sale.findMany({
      where: {
        payment_status: { in: ['PENDING', 'PARTIAL'] },
        payment_method: { is_credit: true },
        status: { name: 'Completada' },
        due_date: { lt: now },
        ...branchFilter(req),
      },
      select: { adjusted_total: true, paymentEntries: { select: { amount: true } } },
    })
    const vencidas = open.filter((s) => balanceOf(s) > ROUND_EPS)
    const charges = [...(await require('./domain/chargeDocuments').chargeTotalsByCustomer(prisma, branchIdsOf(req), now)).values()]
    const cargos = charges.reduce((n, c) => n + c.vencidos, 0), montoCargos = round2(charges.reduce((s, c) => s + c.vencido, 0))
    res.json({
      count: vencidas.length + cargos,
      monto: round2(vencidas.reduce((s, v) => s + balanceOf(v), 0) + montoCargos),
      facturas: vencidas.length,
      cargos,
    })
  } catch (e) {
    next(e)
  }
}

/**
 * GET /api/receivables/customers/:id
 * Estado de cuenta: ventas al crédito del cliente y sus cobros.
 */
exports.statement = async (req, res, next) => {
  try {
    const companyId = requireCompany(req)
    const customer = await prisma.supplier.findFirst({
      where: { id: req.params.id, company_id: companyId },
      select: {
        id: true, name: true, contact: true, phone: true, email: true,
        address: true, tax_id: true, credit_limit: true, party_type: true,
        supplier_payment_terms: CUSTOMER_TERM_PICK,
      },
    })
    if (!customer) fail(404, 'Cliente no encontrado')

    const where = branchFilter(req)
    const historyPage = Math.max(1, Math.trunc(number(req.query?.page) || 1))
    const historySize = Math.min(500, Math.max(1, Math.trunc(number(req.query?.pageSize) || 500)))
    const salesWhere = { customer_contact_id: customer.id, payment_method: { is_credit: true }, status: { name: 'Completada' }, ...where }
    const paymentsWhere = { customer_id: customer.id, ...where }
    const [sales, payments, resumen, totalSales, totalPayments] = await Promise.all([
      prisma.sale.findMany({
        where: {
          customer_contact_id: customer.id,
          payment_method: { is_credit: true },
          status: { name: 'Completada' },
          ...where,
        },
        select: {
          id: true, reference: true, date: true, due_date: true,
          adjusted_total: true, total: true, payment_status: true,
          paymentEntries: { select: { amount: true } },
        },
        orderBy: [{ date: 'desc' }, { id: 'desc' }],
        skip: (historyPage - 1) * historySize, take: historySize,
      }),
      prisma.customerPayment.findMany({
        where: { customer_id: customer.id, ...where },
        select: {
          id: true, amount: true, paid_at: true, reference: true, notes: true, kind: true,
          ...allocationSelect,
          payment_method: { select: { id: true, name: true } },
          registeredBy: { select: { id: true, name: true } },
          applications: {
            select: { amount: true, sale: { select: { id: true, reference: true } } },
          },
        },
        orderBy: [{ paid_at: 'desc' }, { id: 'desc' }],
        skip: (historyPage - 1) * historySize, take: historySize,
      }),
      customerBalance(prisma, customer.id, where),
      prisma.sale.count({ where: salesWhere }),
      prisma.customerPayment.count({ where: paymentsWhere }),
    ])

    const Charges = require('./domain/chargeDocuments')
    const [hydratedPayments, chargeStatement, chargeApplications] = await Promise.all([hydrateReceiptAllocations(prisma,payments), Charges.chargeStatementOf(prisma, customer.id, where), Charges.chargeApplicationsOfReceipts(prisma, payments.map(p => p.id))])
    const origins=await require('../appointments').linkedEngagementOrigins(prisma,req,{paymentIds:payments.map(p=>p.id)})
    const now = new Date()
    res.json({
      history: { page: historyPage, pageSize: historySize, total_sales: totalSales, total_payments: totalPayments, hasNextPage: historyPage * historySize < Math.max(totalSales, totalPayments) },
      customer: {
        ...customer,
        payment_term: customer.supplier_payment_terms[0]?.payment_term ?? null,
        credit_limit: customer.credit_limit == null ? null : round2(number(customer.credit_limit)),
      },
      resumen: {
        ...resumen,
        // Contra el saldo NETO, que es el mismo número que mira el límite al
        // vender: con el bruto la tarjeta diría menos disponible del que hay.
        disponible:
          customer.credit_limit == null
            ? null
            : round2(number(customer.credit_limit) - resumen.saldo_neto),
      },
      ventas: sales.map((s) => ({
        id: s.id,
        reference: s.reference,
        date: s.date,
        due_date: s.due_date,
        total: round2(number(s.adjusted_total)),
        abonado: round2(number(s.adjusted_total) - balanceOf(s)),
        saldo: balanceOf(s),
        payment_status: s.payment_status,
        vencida: Boolean(s.due_date && new Date(s.due_date) < now && s.payment_status !== 'PAID'),
        dias_vencida: s.due_date
          ? Math.max(0, Math.floor((now - new Date(s.due_date)) / 86400000))
          : 0,
      })),
      ...chargeStatement,
      cobros: hydratedPayments.map((p) => {
        const aCargos = chargeApplications.get(p.id) || []
        const aplicado = round2(p.applications.reduce((acc, a) => acc + number(a.amount), 0) + aCargos.reduce((acc, a) => acc + a.amount, 0))
        const allocation=allocationForReceipt(p)
        return {
          id: p.id,
          amount: round2(number(p.amount)),
          paid_at: p.paid_at,
          reference: p.reference,
          notes: p.notes,
          kind: p.kind,
          payment_method: p.payment_method,
          registered_by: p.registeredBy,
          aplicado,
          no_aplicado:Number(allocation.available),comprometido:Number(allocation.committed),devuelto:Number(allocation.refunded),retenido:Number(allocation.held||0),saldo_cancelado:Number(allocation.retired||0),tiene_disputa:!!p.has_dispute,
          engagementId:origins.payments[p.id]||null,
          aplicaciones: [...p.applications.map((a) => ({
            sale_id: a.sale?.id,
            reference: a.sale?.reference,
            amount: round2(number(a.amount)),
          })), ...aCargos],
        }
      }),
    })
  } catch (e) {
    next(e)
  }
}

/**
 * GET /api/receivables/customers/:id/credit-check?amount=123
 * Consulta previa del POS: dice si el cliente puede llevarse ese monto al crédito.
 */
exports.creditCheck = async (req, res, next) => {
  try {
    const companyId = requireCompany(req)
    const customer = await prisma.supplier.findFirst({
      where: { id: req.params.id, company_id: companyId },
      select: {
        id: true, name: true, credit_limit: true,
        supplier_payment_terms: CUSTOMER_TERM_PICK,
      },
    })
    if (!customer) fail(404, 'Cliente no encontrado')
    const amount = number(req.query.amount)
    const result = await checkCredit(prisma, customer, amount, branchFilter(req))

    // El vencimiento sugerido viaja en la misma consulta para que el POS lo
    // pueda mostrar. Antes el plazo del cliente solo se aplicaba en el
    // servidor: el cajero no veía qué fecha iba a quedar, y si el cliente no
    // tenía plazo la venta salía sin vencimiento sin que nada lo dijera.
    const term = customer.supplier_payment_terms[0]?.payment_term
    const netDays = term?.net_days != null ? Number(term.net_days) : null
    res.json({
      customer_id: customer.id,
      customer_name: customer.name,
      payment_term: term ? { name: term.name, net_days: netDays } : null,
      due_date_sugerida:
        netDays != null ? DateTime.now().setZone(await getTimezone(prisma, req.companyId)).plus({ days: netDays }).toISODate() : null,
      ...result,
    })
  } catch (e) {
    next(e)
  }
}

/**
 * POST /api/receivables/payments
 * Registra un cobro y lo aplica FIFO a las ventas al crédito abiertas del cliente.
 */
exports.createPayment = async (req, res, next) => {
  try {
    const companyId = requireCompany(req)
    const branchId = requireBranch(req)
    const uid = req.user?.sub
    if (!uid) fail(401, 'Usuario no autenticado')

    const body = req.body || {}
    const amount = round2(Number(body.amount))
    if (!Number.isFinite(amount) || amount <= 0) {
      fail(400, 'El monto del cobro debe ser mayor a 0')
    }

    let paidAt = new Date()
    if (body.paid_at != null && String(body.paid_at).trim() !== '') {
      const p = new Date(body.paid_at)
      if (Number.isNaN(p.getTime())) fail(400, 'La fecha del cobro es inválida')
      paidAt = p
    }

    const customer = await prisma.supplier.findFirst({
      where: { id: String(body.customer_id || ''), company_id: companyId },
      select: { id: true, name: true },
    })
    if (!customer) fail(404, 'Cliente no encontrado')

    // Aplicación manual: la UI manda a qué facturas va el dinero. Si no viene
    // nada, se reparte FIFO (lo normal en mostrador).
    let manualApplications = null
    if (Array.isArray(body.applications) && body.applications.length > 0) {
      manualApplications = body.applications
    }

    let reference = body.reference != null ? String(body.reference).trim() : ''
    if (reference.length > 255) reference = reference.slice(0, 255)

    const created = await prismaTransaction.$transaction(async (tx) => {
      const requestAttempt = await require('./paymentAttempts').beginPaymentAttempt(tx, { companyId, branchId, userId: uid }, body)
      const { paymentId } = requestAttempt?.paymentId ? { paymentId: requestAttempt.paymentId } : await applyPayment(tx, {
        externalRequest: true, requestAttempt,
        companyId, isAdmin: require('../users/roles/policy').isSystemAdmin(req.user?.role),
        customerId: customer.id,
        branchId,
        amount,
        paidAt,
        paymentMethodId: body.payment_method_id,
        cashRegisterSessionId: body.cash_register_session_id || null,
        reference: reference || null,
        notes: body.notes != null ? String(body.notes).trim() || null : null,
        userId: uid,
        manualApplications,
        allowAdvance: body.allow_advance === true,
        hardware:{origin:'RECEIVABLE_RECEIPT',scope:require('../config/hardware/drawer/events').requestHardwareScope(req)},
      })

      return tx.customerPayment.findUnique({
        where: { id: paymentId },
        select: {
          id: true, amount: true, paid_at: true, reference: true, notes: true,
          payment_method: { select: { id: true, name: true } },
          customer: { select: { id: true, name: true } },
          applications: {
            select: {
              amount: true,
              sale: { select: { id: true, reference: true, payment_status: true } },
            },
          },
        },
      })
    }, PAYMENT_TX_OPTIONS)

    const resumen = await customerBalance(prisma, customer.id, { branch_id: branchId })
    const aCargos = (await require('./domain/chargeDocuments').chargeApplicationsOfReceipts(prisma, [created.id])).get(created.id) || []
    const aplicado = round2(
      created.applications.reduce((acc, a) => acc + number(a.amount), 0) + aCargos.reduce((acc, a) => acc + a.amount, 0)
    )
    res.status(201).json({
      ...created,
      amount: round2(number(created.amount)),
      aplicaciones: created.applications.map((a) => ({
        sale_id: a.sale?.id,
        reference: a.sale?.reference,
        payment_status: a.sale?.payment_status,
        amount: round2(number(a.amount)),
      })).concat(aCargos),
      aplicado,
      no_aplicado: round2(amount - aplicado),
      resumen,
    })
  } catch (e) {
    next(e)
  }
}

/**
 * DELETE /api/receivables/payments/:id
 * Elimina un cobro (corrección) y restaura el estado de las ventas afectadas.
 *
 * Igual que en compras, el asiento contable ya posteado NO se revierte: se
 * corrige con un asiento manual. La respuesta avisa si existía, para que la UI
 * lo pueda advertir en vez de que pase en silencio.
 */
exports.deletePayment = async (req, res, next) => {
  try {
    if (!hasPerm(req.user, 'receivables.cancel_payment')) fail(403, 'Necesitas permiso para anular cobros')
    const companyId = requireCompany(req)
    const uid = req.user?.sub
    if (!uid) fail(401, 'Usuario no autenticado')

    const payment = await prisma.customerPayment.findFirst({
      where: { id: req.params.id, branch: { company_id: companyId },...branchFilter(req) },
      select: {
        id: true, customer_id: true, branch_id: true, cash_register_session_id: true,
        applications: { select: { sale_id: true, sale:{select:{appointment_engagement:{select:{id:true}}}} } },
        commitments:{select:{id:true},take:1},allocation_events:{select:{id:true},take:1},refunds:{select:{id:true},take:1},
      },
    })
    if (!payment) fail(404, 'Cobro no encontrado')
    const assertDeletable=row=>{if(row?.commitments?.length||row?.allocation_events?.length||row?.refunds?.length||row?.applications?.some(a=>a.sale?.appointment_engagement))throw Object.assign(new ReceivableError('Este recibo tiene historial de una contratación. Corrígelo mediante una liberación o devolución trazable',409),{code:'PAYMENT_LINKED_TO_ENGAGEMENT'})}
    assertDeletable(payment)

    const posted = await prisma.journalEntry.findFirst({
      where: { company_id: companyId, source_type: 'SALE_PAYMENT', source_id: payment.id },
      select: { id: true, entry_number: true },
    })

    const saleIds = [...new Set(payment.applications.map((a) => a.sale_id))]
    await prisma.$transaction(async (tx) => {
      if (payment.cash_register_session_id) {
        const boundary = require('../../services/cashSessionBoundary')
        const session = await boundary.lockScopedSession(tx, { companyId, branchId: payment.branch_id, userId: uid }, payment.cash_register_session_id)
        if (session.money_event_version === 1 && await require('../cash-closure/eventStorage').findEvent(tx, 'CUSTOMER_PAYMENT', payment.id)) fail(409, 'Este cobro ya forma parte del registro de caja. Corrígelo con un reintegro trazable; no puede eliminarse.')
        boundary.assertSessionOperation(session, { userId: uid, isAdmin: require('../users/roles/policy').isSystemAdmin(req.user?.role) })
      }
      await lockCustomer(tx, payment.customer_id)
      if (await require('./domain/chargeDocuments').receiptDisputeDependency(tx, payment.id)) throw Object.assign(new ReceivableError('Este cobro está vinculado a una disputa o a un cargo por contracargo. Corrígelo desde su expediente.', 409), { code: 'RECEIPT_DISPUTE_DEPENDENCY' })
      assertDeletable(await tx.customerPayment.findUnique({where:{id:payment.id},select:{applications:{select:{sale:{select:{appointment_engagement:{select:{id:true}}}}}},commitments:{select:{id:true},take:1},allocation_events:{select:{id:true},take:1},refunds:{select:{id:true},take:1}}}))
      await tx.customerPayment.delete({ where: { id: payment.id } })
      for (const saleId of saleIds) await syncSaleStatus(tx, saleId)
    }, PAYMENT_TX_OPTIONS)

    const resumen = await customerBalance(prisma, payment.customer_id, { branch_id: payment.branch_id })
    res.json({
      deleted: payment.id,
      ventas_afectadas: saleIds.length,
      resumen,
      had_journal_entry: Boolean(posted),
      journal_entry_number: posted?.entry_number ?? null,
    })
  } catch (e) {
    next(e)
  }
}

/**
 * POST /api/receivables/adjustments
 * Nota de crédito o castigo por incobrable: baja la deuda sin que entre dinero.
 *
 * Comparte tabla y aplicación FIFO con los cobros porque el efecto sobre la
 * cartera es idéntico; lo único que cambia es la contrapartida del asiento
 * (devoluciones sobre ventas o gasto por incobrables en vez de Caja/Bancos).
 */
exports.createAdjustment = async (req, res, next) => {
  try {
    const companyId = requireCompany(req)
    const branchId = requireBranch(req)
    const uid = req.user?.sub
    if (!uid) fail(401, 'Usuario no autenticado')

    const body = req.body || {}
    const kind = String(body.kind || '').toUpperCase()
    if (!ADJUSTMENT_KINDS.includes(kind)) {
      fail(400, 'El tipo de ajuste debe ser CREDIT_NOTE o WRITE_OFF')
    }

    const amount = round2(Number(body.amount))
    if (!Number.isFinite(amount) || amount <= 0) {
      fail(400, 'El monto del ajuste debe ser mayor a 0')
    }

    // Un ajuste borra deuda de un plumazo: sin motivo escrito no hay forma de
    // auditar por qué se perdonaron esos quetzales.
    const notes = body.notes != null ? String(body.notes).trim() : ''
    if (!notes) fail(400, 'El ajuste requiere un motivo')

    const customer = await prisma.supplier.findFirst({
      where: { id: String(body.customer_id || ''), company_id: companyId },
      select: { id: true, name: true },
    })
    if (!customer) fail(404, 'Cliente no encontrado')

    let paidAt = new Date()
    if (body.date != null && String(body.date).trim() !== '') {
      const d = new Date(body.date)
      if (Number.isNaN(d.getTime())) fail(400, 'La fecha del ajuste es inválida')
      paidAt = d
    }

    const created = await prisma.$transaction(async (tx) => {
      const { paymentId } = await applyPayment(tx, {
        customerId: customer.id,
        branchId,
        amount,
        paidAt,
        paymentMethodId: null,
        cashRegisterSessionId: null,
        reference: body.reference != null ? String(body.reference).trim() || null : null,
        notes,
        userId: uid,
        kind,
        manualApplications: Array.isArray(body.applications) && body.applications.length
          ? body.applications
          : null,
      })
      return tx.customerPayment.findUnique({
        where: { id: paymentId },
        select: {
          id: true, amount: true, paid_at: true, reference: true, notes: true, kind: true,
          customer: { select: { id: true, name: true } },
          applications: {
            select: {
              amount: true,
              sale: { select: { id: true, reference: true, payment_status: true } },
            },
          },
        },
      })
    }, PAYMENT_TX_OPTIONS)

    const resumen = await customerBalance(prisma, customer.id, { branch_id: branchId })
    res.status(201).json({
      ...created,
      amount: round2(number(created.amount)),
      aplicaciones: created.applications.map((a) => ({
        sale_id: a.sale?.id,
        reference: a.sale?.reference,
        payment_status: a.sale?.payment_status,
        amount: round2(number(a.amount)),
      })),
      resumen,
    })
  } catch (e) {
    next(e)
  }
}

/**
 * POST /api/receivables/customers/:id/apply-credit
 * Aplica el saldo a favor del cliente a sus facturas abiertas.
 *
 * No genera asiento: ese dinero ya entró y ya se contabilizó al recibir el
 * cobro. Esto solo decide a qué facturas se imputa.
 */
exports.applyCredit = async (req, res, next) => {
  try {
    const companyId = requireCompany(req)
    const branchId = requireBranch(req)

    const customer = await prisma.supplier.findFirst({
      where: { id: req.params.id, company_id: companyId },
      select: { id: true, name: true },
    })
    if (!customer) fail(404, 'Cliente no encontrado')

    const applied = await prisma.$transaction(
      (tx) => applyAvailableCredit(tx, customer.id, branchId, { companyId, userId: req.user?.sub }),
      PAYMENT_TX_OPTIONS
    )

    const resumen = await customerBalance(prisma, customer.id, { branch_id: branchId })
    res.json({
      aplicado: round2(applied.reduce((s, a) => s + a.amount, 0)),
      ventas_afectadas: new Set(applied.filter((a) => a.sale_id).map((a) => a.sale_id)).size,
      cargos_afectados: new Set(applied.filter((a) => a.documentId).map((a) => a.documentId)).size,
      resumen,
    })
  } catch (e) {
    next(e)
  }
}

/**
 * PATCH /api/receivables/sales/:id/due-date
 * Prórroga: mueve el vencimiento de una venta al crédito ya emitida.
 */
exports.updateDueDate = async (req, res, next) => {
  try {
    const companyId = requireCompany(req)
    const sale = await prisma.sale.findFirst({
      where: {
        id: req.params.id,
        branch: { company_id: companyId },
        payment_method: { is_credit: true },
        status:{name:require('../sales/commercialState').CONFIRMED_SALE_STATUS},
        ...branchFilter(req),
      },
      select: { id: true, reference: true, due_date: true, date: true, payment_status: true },
    })
    if (!sale) fail(404, 'Venta al crédito no encontrada')
    if (sale.payment_status === 'PAID') fail(400, 'La venta ya está cancelada')

    const raw = req.body?.due_date
    if (raw == null || String(raw).trim() === '') fail(400, 'Indique la nueva fecha de vencimiento')
    const due = creditDueDate(raw, null, new Date(sale.date), await getTimezone(prisma, companyId))

    const updated = await prisma.sale.update({
      where: { id: sale.id },
      data: { due_date: due },
      select: { id: true, reference: true, due_date: true },
    })
    res.json(updated)
  } catch (e) {
    next(e)
  }
}

/**
 * GET /api/receivables/payments/:id
 * Datos del recibo de un cobro, para imprimirlo o exportarlo.
 */
exports.receipt = async (req, res, next) => {
  try {
    const companyId = requireCompany(req)
    const payment = await prisma.customerPayment.findFirst({
      where: { id: req.params.id, branch: { company_id: companyId } },
      select: {
        id: true, amount: true, paid_at: true, reference: true, notes: true, kind: true,
        ...allocationSelect,
        payment_method: { select: { id: true, name: true } },
        customer: { select: { id: true, name: true, tax_id: true, phone: true, address: true } },
        branch: { select: { id: true, name: true } },
        registeredBy: { select: { id: true, name: true } },
        applications: {
          select: {
            amount: true,
            sale: { select: { id: true, reference: true, date: true, due_date: true, adjusted_total: true } },
          },
        },
      },
    })
    if (!payment) fail(404, 'Cobro no encontrado')

    const [hydratedPayment]=await hydrateReceiptAllocations(prisma,[payment])
    const allocation=allocationForReceipt(hydratedPayment)
    const aCargos = (await require('./domain/chargeDocuments').chargeApplicationsOfReceipts(prisma, [payment.id])).get(payment.id) || []
    const aplicado = round2(payment.applications.reduce((s, a) => s + number(a.amount), 0) + aCargos.reduce((s, a) => s + a.amount, 0))
    const resumen = await customerBalance(prisma, payment.customer.id, branchFilter(req))
    res.json({
      ...payment,
      amount: round2(number(payment.amount)),
      aplicado,
      no_aplicado:Number(allocation.available),comprometido:Number(allocation.committed),devuelto:Number(allocation.refunded),retenido:Number(allocation.held||0),saldo_cancelado:Number(allocation.retired||0),tiene_disputa:!!hydratedPayment.has_dispute,
      aplicaciones: payment.applications.map((a) => ({
        sale_id: a.sale?.id,
        reference: a.sale?.reference,
        date: a.sale?.date,
        due_date: a.sale?.due_date,
        total: round2(number(a.sale?.adjusted_total)),
        amount: round2(number(a.amount)),
      })).concat(aCargos),
      resumen,
    })
  } catch (e) {
    next(e)
  }
}
