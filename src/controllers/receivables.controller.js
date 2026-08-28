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
  applyAvailableCredit,
  syncSaleStatus,
  customerBalance,
  unappliedPayments,
  checkCredit,
  agingBucket,
  lockCustomer,
} = require('../services/receivables')

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
          SUM(cp.amount - COALESCE(a.applied, 0)) AS credito
        FROM customer_payments cp
        LEFT JOIN (
          SELECT customer_payment_id, SUM(amount) AS applied
          FROM sale_payment_entries GROUP BY customer_payment_id
        ) a ON a.customer_payment_id = cp.id
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
      FROM deuda d
      FULL OUTER JOIN credito c ON c.cid = d.cid
      JOIN suppliers sup ON sup.id = COALESCE(d.cid, c.cid)
      WHERE COALESCE(d.saldo, 0) > ${ROUND_EPS}
         OR COALESCE(c.credito, 0) > ${ROUND_EPS}
      ORDER BY vencido DESC, saldo DESC
    `
    const items = rows.map((r) => {
      const saldo = round2(number(r.saldo))
      const credito = round2(number(r.credito))
      return {
        customer_id: r.customer_id,
        customer_name: r.customer_name,
        credit_limit: r.credit_limit == null ? null : round2(number(r.credit_limit)),
        saldo,
        vencido: round2(number(r.vencido)),
        facturas: Number(r.facturas),
        vence_primero: r.vence_primero,
        credito_disponible: credito,
        saldo_neto: round2(Math.max(0, saldo - credito)),
      }
    })
    res.json({
      items,
      total_por_cobrar: round2(items.reduce((s, i) => s + i.saldo, 0)),
      total_vencido: round2(items.reduce((s, i) => s + i.vencido, 0)),
      total_credito: round2(items.reduce((s, i) => s + i.credito_disponible, 0)),
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
          id: true, amount: true, paid_at: true, reference: true, notes: true, kind: true,
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
      cobros: payments.map((p) => {
        const aplicado = round2(p.applications.reduce((acc, a) => acc + number(a.amount), 0))
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
          no_aplicado: round2(number(p.amount) - aplicado),
          aplicaciones: p.applications.map((a) => ({
            sale_id: a.sale?.id,
            reference: a.sale?.reference,
            amount: round2(number(a.amount)),
          })),
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
        supplier_payment_terms: {
          where: { is_default: true },
          select: { payment_term: { select: { name: true, net_days: true } } },
          take: 1,
        },
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
        netDays != null ? new Date(Date.now() + netDays * 86400000).toISOString() : null,
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

    // Aplicación manual: la UI manda a qué facturas va el dinero. Si no viene
    // nada, se reparte FIFO (lo normal en mostrador).
    let manualApplications = null
    if (Array.isArray(body.applications) && body.applications.length > 0) {
      manualApplications = body.applications
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
        manualApplications,
        allowAdvance: body.allow_advance === true,
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
    const aplicado = round2(
      created.applications.reduce((acc, a) => acc + number(a.amount), 0)
    )
    res.status(201).json({
      ...created,
      amount: round2(number(created.amount)),
      aplicaciones: created.applications.map((a) => ({
        sale_id: a.sale?.id,
        reference: a.sale?.reference,
        payment_status: a.sale?.payment_status,
        amount: round2(number(a.amount)),
      })),
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
      await lockCustomer(tx, payment.customer_id)
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
      (tx) => applyAvailableCredit(tx, customer.id, branchId),
      PAYMENT_TX_OPTIONS
    )

    const resumen = await customerBalance(prisma, customer.id, { branch_id: branchId })
    res.json({
      aplicado: round2(applied.reduce((s, a) => s + a.amount, 0)),
      ventas_afectadas: new Set(applied.map((a) => a.sale_id)).size,
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
        ...branchFilter(req),
      },
      select: { id: true, reference: true, due_date: true, date: true, payment_status: true },
    })
    if (!sale) fail(404, 'Venta al crédito no encontrada')
    if (sale.payment_status === 'PAID') fail(400, 'La venta ya está cancelada')

    const raw = req.body?.due_date
    if (raw == null || String(raw).trim() === '') fail(400, 'Indique la nueva fecha de vencimiento')
    const due = new Date(String(raw).length === 10 ? `${raw}T12:00:00-06:00` : raw)
    if (Number.isNaN(due.getTime())) fail(400, 'La fecha de vencimiento es inválida')
    if (due < new Date(sale.date)) {
      fail(400, 'El vencimiento no puede ser anterior a la fecha de la venta')
    }

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

    const aplicado = round2(payment.applications.reduce((s, a) => s + number(a.amount), 0))
    const resumen = await customerBalance(prisma, payment.customer.id, branchFilter(req))
    res.json({
      ...payment,
      amount: round2(number(payment.amount)),
      aplicado,
      no_aplicado: round2(number(payment.amount) - aplicado),
      aplicaciones: payment.applications.map((a) => ({
        sale_id: a.sale?.id,
        reference: a.sale?.reference,
        date: a.sale?.date,
        due_date: a.sale?.due_date,
        total: round2(number(a.sale?.adjusted_total)),
        amount: round2(number(a.amount)),
      })),
      resumen,
    })
  } catch (e) {
    next(e)
  }
}
