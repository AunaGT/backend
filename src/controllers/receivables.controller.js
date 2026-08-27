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
const { prisma } = require('../models/prisma')
const { requireCompany, requireBranch } = require('../middlewares/tenant')
const { round2 } = require('../services/accounting/logic')
const {
  ROUND_EPS,
  ReceivableError,
  balanceOf,
  applyPayment,
  syncSaleStatus,
  customerBalance,
  checkCredit,
  agingBucket,
} = require('../services/receivables')

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
    const rows = await prisma.$queryRaw`
      SELECT
        sup.id::text                AS customer_id,
        sup.name                    AS customer_name,
        sup.credit_limit            AS credit_limit,
        SUM(s.adjusted_total - COALESCE(p.paid, 0))                          AS saldo,
        SUM(CASE WHEN s.due_date IS NOT NULL AND s.due_date < NOW()
                 THEN s.adjusted_total - COALESCE(p.paid, 0) ELSE 0 END)     AS vencido,
        COUNT(*)                                                             AS facturas,
        MIN(s.due_date)                                                      AS vence_primero
      FROM sales s
      JOIN suppliers sup       ON sup.id = s.customer_contact_id
      JOIN sale_statuses st    ON st.id = s.status_id
      JOIN payment_methods pm  ON pm.id = s.payment_method_id
      LEFT JOIN (
        SELECT sale_id, SUM(amount) AS paid FROM sale_payment_entries GROUP BY sale_id
      ) p ON p.sale_id = s.id
      WHERE pm.is_credit
        AND st.name = 'Completada'
        AND s.payment_status IN ('PENDING', 'PARTIAL')
        AND s.branch_id IN (${Prisma.join(ids.map((i) => Prisma.sql`${i}::uuid`))})
      GROUP BY sup.id, sup.name, sup.credit_limit
      HAVING SUM(s.adjusted_total - COALESCE(p.paid, 0)) > ${ROUND_EPS}
      ORDER BY vencido DESC, saldo DESC
    `
    const items = rows.map((r) => ({
      customer_id: r.customer_id,
      customer_name: r.customer_name,
      credit_limit: r.credit_limit == null ? null : round2(number(r.credit_limit)),
      saldo: round2(number(r.saldo)),
      vencido: round2(number(r.vencido)),
      facturas: Number(r.facturas),
      vence_primero: r.vence_primero,
    }))
    res.json({
      items,
      total_por_cobrar: round2(items.reduce((s, i) => s + i.saldo, 0)),
      total_vencido: round2(items.reduce((s, i) => s + i.vencido, 0)),
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
    res.json({
      count: vencidas.length,
      monto: round2(vencidas.reduce((s, v) => s + balanceOf(v), 0)),
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
      },
    })
    if (!customer) fail(404, 'Cliente no encontrado')

    const where = branchFilter(req)
    const [sales, payments, resumen] = await Promise.all([
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
        orderBy: [{ date: 'desc' }],
        take: 500,
      }),
      prisma.customerPayment.findMany({
        where: { customer_id: customer.id, ...where },
        select: {
          id: true, amount: true, paid_at: true, reference: true, notes: true,
          payment_method: { select: { id: true, name: true } },
          registeredBy: { select: { id: true, name: true } },
          applications: {
            select: { amount: true, sale: { select: { id: true, reference: true } } },
          },
        },
        orderBy: { paid_at: 'desc' },
        take: 500,
      }),
      customerBalance(prisma, customer.id, where),
    ])

    const now = new Date()
    res.json({
      customer: {
        ...customer,
        credit_limit: customer.credit_limit == null ? null : round2(number(customer.credit_limit)),
      },
      resumen: {
        ...resumen,
        disponible:
          customer.credit_limit == null
            ? null
            : round2(number(customer.credit_limit) - resumen.saldo),
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
      cobros: payments.map((p) => ({
        id: p.id,
        amount: round2(number(p.amount)),
        paid_at: p.paid_at,
        reference: p.reference,
        notes: p.notes,
        payment_method: p.payment_method,
        registered_by: p.registeredBy,
        aplicaciones: p.applications.map((a) => ({
          sale_id: a.sale?.id,
          reference: a.sale?.reference,
          amount: round2(number(a.amount)),
        })),
      })),
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
      select: { id: true, name: true, credit_limit: true },
    })
    if (!customer) fail(404, 'Cliente no encontrado')
    const amount = number(req.query.amount)
    const result = await checkCredit(prisma, customer, amount, branchFilter(req))
    res.json({ customer_id: customer.id, customer_name: customer.name, ...result })
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

    const method = await prisma.paymentMethod.findUnique({
      where: { id: Number(body.payment_method_id) },
      select: { id: true, name: true, is_credit: true },
    })
    if (!method) fail(400, 'Método de pago inválido')
    // Cobrar «al crédito» no significa nada: el cobro es justo lo que cancela el crédito.
    if (method.is_credit) fail(400, 'Un cobro no puede registrarse con un método de crédito')

    if (body.cash_register_session_id) {
      const sess = await prisma.cashRegisterSession.findFirst({
        where: { id: String(body.cash_register_session_id), cashRegister: { branch_id: branchId } },
        select: { id: true, status: true },
      })
      if (!sess) fail(400, 'Sesión de caja no encontrada en esta sucursal')
      if (sess.status !== 'OPEN') fail(400, 'La sesión de caja ya está cerrada')
    }

    let reference = body.reference != null ? String(body.reference).trim() : ''
    if (reference.length > 255) reference = reference.slice(0, 255)

    const created = await prisma.$transaction(async (tx) => {
      const { paymentId } = await applyPayment(tx, {
        customerId: customer.id,
        branchId,
        amount,
        paidAt,
        paymentMethodId: method.id,
        cashRegisterSessionId: body.cash_register_session_id || null,
        reference: reference || null,
        notes: body.notes != null ? String(body.notes).trim() || null : null,
        userId: uid,
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
 * DELETE /api/receivables/payments/:id
 * Elimina un cobro (corrección) y restaura el estado de las ventas afectadas.
 *
 * Igual que en compras, el asiento contable ya posteado NO se revierte: se
 * corrige con un asiento manual. La respuesta avisa si existía, para que la UI
 * lo pueda advertir en vez de que pase en silencio.
 */
exports.deletePayment = async (req, res, next) => {
  try {
    const companyId = requireCompany(req)
    const uid = req.user?.sub
    if (!uid) fail(401, 'Usuario no autenticado')

    const payment = await prisma.customerPayment.findFirst({
      where: { id: req.params.id, branch: { company_id: companyId } },
      select: {
        id: true, customer_id: true, branch_id: true,
        applications: { select: { sale_id: true } },
      },
    })
    if (!payment) fail(404, 'Cobro no encontrado')

    const posted = await prisma.journalEntry.findFirst({
      where: { company_id: companyId, source_type: 'SALE_PAYMENT', source_id: payment.id },
      select: { id: true, entry_number: true },
    })

    const saleIds = [...new Set(payment.applications.map((a) => a.sale_id))]
    await prisma.$transaction(async (tx) => {
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
