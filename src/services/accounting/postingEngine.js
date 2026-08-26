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
 * Motor de posteo desacoplado: contabiliza operaciones (ventas, devoluciones,
 * compras, abonos) que aún no tienen asiento. Idempotente vía unique
 * (source_type, source_id). No modifica ningún flujo operativo.
 */

const { Prisma } = require('@prisma/client')
const { splitIva, round2 } = require('./logic')
const { createEntry, getDefaultAccounts, getTaxConfig, getCashClosureAccounts, AccountingError } = require('./core')

/**
 * Cuántas operaciones sin contabilizar se procesan por corrida. Antes se traían
 * TODAS las ventas de la empresa —sin ventana ni paginación— más el conjunto de
 * las ya contabilizadas en memoria para descartarlas: con doscientas ventas es
 * instantáneo y con cincuenta mil es un timeout del pooler.
 */
const BATCH = 500

/**
 * ids todavía sin asiento, en orden cronológico y por tandas. El descarte va en
 * la base (NOT EXISTS contra el índice único de idempotencia), no en memoria.
 * `candidatos` debe seleccionar `id text` y `ord` para ordenar.
 */
async function pendingIds(prisma, sourceType, companyId, candidatos) {
  const rows = await prisma.$queryRaw`
    WITH c AS (${candidatos})
    SELECT c.id FROM c
    WHERE NOT EXISTS (
      SELECT 1 FROM journal_entries je
      WHERE je.company_id = ${companyId}::uuid
        AND je.source_type = ${sourceType}::"JournalSourceType"
        AND je.source_id = c.id
    )
    ORDER BY c.ord ASC
    LIMIT ${BATCH}
  `
  return rows.map((r) => String(r.id))
}

/** Cuenta de cargo según método de pago: efectivo→Caja, crédito→Clientes, resto→Bancos. */
function cashOrBank(defaults, paymentMethodName) {
  const name = String(paymentMethodName || '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '')
  if (name.includes('efectivo')) return defaults.cash
  if (name.includes('credito')) return defaults.receivables
  return defaults.bank
}

/** Postea una operación en su propia transacción; devuelve null si ok, o razón si se omite. */
async function tryPost(prisma, build) {
  try {
    await prisma.$transaction(async (tx) => {
      const payload = await build(tx)
      if (payload) await createEntry(tx, payload)
    }, { timeout: 30000, maxWait: 10000 }) // Supabase pooler puede exceder los 5s por defecto
    return null
  } catch (e) {
    if (e instanceof AccountingError) return e.message
    if (e && e.code === 'P2002') return null // ya contabilizada (carrera): idempotente
    throw e
  }
}

async function postPendingOperations(prisma, userId, companyId) {
  if (!companyId) throw new AccountingError('companyId es obligatorio para contabilizar')
  const defaults = await getDefaultAccounts(prisma, companyId)
  // GENERAL: desglosa IVA débito/crédito. PEQUENO: registra por totales (sin
  // crédito fiscal) y acumula la tarifa fija sobre ventas (gasto vs. pasivo).
  const { regime, ivaRate, pequenoRate } = await getTaxConfig(prisma, companyId)
  const splitVat = regime === 'GENERAL'
  // Los costos (product.cost, unit_cost) se capturan a precio de factura (con IVA);
  // en régimen general el costo contable es la base para cuadrar con el inventario.
  const costBase = (c) => (splitVat ? round2(c / (1 + ivaRate)) : c)
  const pequenoTaxOf = (amount) => (splitVat ? 0 : round2(amount * pequenoRate))
  let posted = 0
  const skipped = []
  const track = (source, reason) => {
    if (reason) skipped.push({ source, reason })
    else posted += 1
  }

  // ---- Ventas completadas ----
  const pendingSales = await pendingIds(prisma, 'SALE', companyId, Prisma.sql`
    SELECT s.id::text AS id, s.date AS ord
    FROM sales s
    JOIN branches b ON b.id = s.branch_id
    JOIN sale_statuses st ON st.id = s.status_id
    WHERE b.company_id = ${companyId}::uuid AND st.name = 'Completada'
  `)
  const sales = await prisma.sale.findMany({
    where: { id: { in: pendingSales } },
    select: {
      id: true, reference: true, date: true, total: true, customer: true, branch_id: true,
      customerContact: { select: { name: true } },
      payment_method: { select: { name: true } },
      sale_items: { select: { qty: true, unit_cost: true, product: { select: { cost: true } } } },
    },
    orderBy: { date: 'asc' },
  })
  for (const sale of sales) {
    const label = `Venta ${sale.reference || sale.id.slice(0, 8)}`
    const total = round2(sale.total)
    if (total <= 0) { track(label, 'total 0'); continue }
    const { base, iva } = splitIva(total, ivaRate)
    // El costo congelado en la venta; las ventas viejas (sin él) caen al costo
    // del producto, que es lo que se usaba antes de guardarlo por línea.
    const cost = costBase(round2(sale.sale_items.reduce(
      (s, i) => s + i.qty * Number(i.unit_cost ?? i.product.cost ?? 0), 0
    )))
    const chargeAccount = cashOrBank(defaults, sale.payment_method?.name)
    const lines = splitVat
      ? [
          { account_id: chargeAccount.id, debit: total, credit: 0 },
          { account_id: defaults.sales.id, debit: 0, credit: base },
          { account_id: defaults.ivaDebit.id, debit: 0, credit: iva },
        ]
      : [
          { account_id: chargeAccount.id, debit: total, credit: 0 },
          { account_id: defaults.sales.id, debit: 0, credit: total },
        ]
    // Ventas al crédito: la línea de Clientes identifica al contacto que debe.
    if (chargeAccount.id === defaults.receivables.id) {
      const customerName = sale.customerContact?.name || sale.customer
      if (customerName) lines[0].description = `Cliente: ${customerName}`
    }
    const saleTax = pequenoTaxOf(total)
    if (saleTax > 0) {
      lines.push({ account_id: defaults.pequenoTaxExpense.id, debit: saleTax, credit: 0 })
      lines.push({ account_id: defaults.pequenoTax.id, debit: 0, credit: saleTax })
    }
    if (cost > 0) {
      lines.push({ account_id: defaults.cogs.id, debit: cost, credit: 0 })
      lines.push({ account_id: defaults.inventory.id, debit: 0, credit: cost })
    }
    const reason = await tryPost(prisma, () => ({
      company_id: companyId,
      branch_id: sale.branch_id,
      date: sale.date,
      description: label,
      source_type: 'SALE',
      source_id: sale.id,
      created_by: userId,
      lines,
    }))
    track(label, reason)
  }

  // ---- Devoluciones aprobadas/completadas ----
  const pendingReturns = await pendingIds(prisma, 'RETURN', companyId, Prisma.sql`
    SELECT r.id::text AS id, r.return_date AS ord
    FROM returns r
    JOIN sales s ON s.id = r.sale_id
    JOIN branches b ON b.id = s.branch_id
    JOIN return_statuses rs ON rs.id = r.status_id
    WHERE b.company_id = ${companyId}::uuid AND rs.name IN ('Aprobada', 'Completada')
  `)
  const returns = await prisma.return.findMany({
    where: { id: { in: pendingReturns } },
    select: {
      id: true, return_date: true, total_refund: true,
      sale: {
        select: {
          reference: true, customer: true, branch_id: true,
          customerContact: { select: { name: true } },
          payment_method: { select: { name: true } },
        },
      },
      return_items: {
        select: {
          qty_returned: true,
          // Lo devuelto vuelve al inventario al costo con el que salió.
          sale_item: { select: { unit_cost: true } },
          product: { select: { cost: true } },
        },
      },
    },
    orderBy: { return_date: 'asc' },
  })
  for (const ret of returns) {
    const label = `Devolución venta ${ret.sale?.reference || ret.id.slice(0, 8)}`
    const refund = round2(ret.total_refund)
    if (refund <= 0) { track(label, 'monto 0'); continue }
    const { base, iva } = splitIva(refund, ivaRate)
    const cost = costBase(round2(ret.return_items.reduce(
      (s, i) => s + i.qty_returned * Number(i.sale_item?.unit_cost ?? i.product.cost ?? 0), 0
    )))
    const refundAccount = cashOrBank(defaults, ret.sale?.payment_method?.name)
    const lines = splitVat
      ? [
          { account_id: defaults.salesReturns.id, debit: base, credit: 0 },
          { account_id: defaults.ivaDebit.id, debit: iva, credit: 0 },
          { account_id: refundAccount.id, debit: 0, credit: refund },
        ]
      : [
          { account_id: defaults.salesReturns.id, debit: refund, credit: 0 },
          { account_id: refundAccount.id, debit: 0, credit: refund },
        ]
    if (refundAccount.id === defaults.receivables.id) {
      const customerName = ret.sale?.customerContact?.name || ret.sale?.customer
      if (customerName) {
        const refundLine = lines.find((l) => l.account_id === refundAccount.id)
        if (refundLine) refundLine.description = `Cliente: ${customerName}`
      }
    }
    const refundTax = pequenoTaxOf(refund)
    if (refundTax > 0) {
      lines.push({ account_id: defaults.pequenoTax.id, debit: refundTax, credit: 0 })
      lines.push({ account_id: defaults.pequenoTaxExpense.id, debit: 0, credit: refundTax })
    }
    if (cost > 0) {
      lines.push({ account_id: defaults.inventory.id, debit: cost, credit: 0 })
      lines.push({ account_id: defaults.cogs.id, debit: 0, credit: cost })
    }
    const reason = await tryPost(prisma, () => ({
      company_id: companyId,
      branch_id: ret.sale?.branch_id ?? null,
      date: ret.return_date,
      description: label,
      source_type: 'RETURN',
      source_id: ret.id,
      created_by: userId,
      lines,
    }))
    track(label, reason)
  }

  // ---- Compras (ingresos de mercancía) ----
  // Las compras se recorren dos veces (asiento de compra y pago sintético del
  // flujo viejo), así que acá se traen las pendientes de cualquiera de los dos.
  const pendingPurchases = await pendingIds(prisma, 'PURCHASE', companyId, Prisma.sql`
    SELECT im.id::text AS id, im.date AS ord
    FROM incoming_merchandise im
    JOIN branches b ON b.id = im.branch_id
    WHERE b.company_id = ${companyId}::uuid
  `)
  const pendingSynthPayments = await pendingIds(prisma, 'PURCHASE_PAYMENT', companyId, Prisma.sql`
    SELECT ('pm-synth:' || im.id::text) AS id, im.date AS ord
    FROM incoming_merchandise im
    JOIN branches b ON b.id = im.branch_id
    WHERE b.company_id = ${companyId}::uuid AND im.payment_status = 'PAID'
  `)
  const synthPurchaseIds = pendingSynthPayments.map((k) => k.slice('pm-synth:'.length))
  const purchases = await prisma.incomingMerchandise.findMany({
    where: { id: { in: [...new Set([...pendingPurchases, ...synthPurchaseIds])] } },
    select: {
      id: true, date: true, payment_status: true, paid_at: true, branch_id: true,
      supplier: { select: { name: true } },
      items: { select: { quantity: true, unit_cost: true } },
      paymentEntries: { select: { id: true } },
    },
    orderBy: { date: 'asc' },
  })
  // `purchases` trae también las que solo necesitan el pago sintético de más
  // abajo, así que acá se filtran las que de verdad esperan asiento de compra.
  const esperaAsientoDeCompra = new Set(pendingPurchases)
  for (const purchase of purchases) {
    if (!esperaAsientoDeCompra.has(purchase.id)) continue
    const label = `Compra a ${purchase.supplier?.name || 'proveedor'} (${purchase.id.slice(0, 8)})`
    const total = round2(purchase.items.reduce((s, i) => s + i.quantity * Number(i.unit_cost), 0))
    if (total <= 0) { track(label, 'total 0'); continue }
    const { base, iva } = splitIva(total, ivaRate)
    const reason = await tryPost(prisma, () => ({
      company_id: companyId,
      branch_id: purchase.branch_id,
      date: purchase.date,
      description: `Compra a ${purchase.supplier?.name || 'proveedor'}`,
      source_type: 'PURCHASE',
      source_id: purchase.id,
      created_by: userId,
      lines: splitVat
        ? [
            { account_id: defaults.inventory.id, debit: base, credit: 0 },
            { account_id: defaults.ivaCredit.id, debit: iva, credit: 0 },
            { account_id: defaults.payables.id, debit: 0, credit: total },
          ]
        : [
            { account_id: defaults.inventory.id, debit: total, credit: 0 },
            { account_id: defaults.payables.id, debit: 0, credit: total },
          ],
    }))
    track(label, reason)
  }

  // ---- Abonos a proveedores ----
  const pendingPayments = await pendingIds(prisma, 'PURCHASE_PAYMENT', companyId, Prisma.sql`
    SELECT pe.id::text AS id, pe.paid_at AS ord
    FROM incoming_merchandise_payment_entries pe
    JOIN incoming_merchandise im ON im.id = pe.incoming_merchandise_id
    JOIN branches b ON b.id = im.branch_id
    WHERE b.company_id = ${companyId}::uuid
  `)
  const payments = await prisma.incomingMerchandisePaymentEntry.findMany({
    where: { id: { in: pendingPayments } },
    select: {
      id: true, amount: true, paid_at: true,
      incomingMerchandise: { select: { branch_id: true, supplier: { select: { name: true } } } },
    },
    orderBy: { paid_at: 'asc' },
  })
  for (const pay of payments) {
    const label = `Abono a ${pay.incomingMerchandise?.supplier?.name || 'proveedor'} (${pay.id.slice(0, 8)})`
    const amount = round2(pay.amount)
    if (amount <= 0) { track(label, 'monto 0'); continue }
    const reason = await tryPost(prisma, () => ({
      company_id: companyId,
      branch_id: pay.incomingMerchandise?.branch_id ?? null,
      date: pay.paid_at,
      description: `Abono a ${pay.incomingMerchandise?.supplier?.name || 'proveedor'}`,
      source_type: 'PURCHASE_PAYMENT',
      source_id: pay.id,
      created_by: userId,
      lines: [
        { account_id: defaults.payables.id, debit: amount, credit: 0 },
        { account_id: defaults.cash.id, debit: 0, credit: amount },
      ],
    }))
    track(label, reason)
  }

  // ---- Ajustes de inventario (manuales, conteos, bajas de lote) ----
  // Sin esto la cuenta de Inventario solo sube con compras y baja con ventas, y
  // se separa de la valuación física sin que nada lo avise. Se excluyen a
  // propósito: traslados y movimientos internos (valor neto cero para la
  // empresa), INITIAL (carga de apertura, no es un gasto) y los kits, que son
  // una reclasificación entre productos.

  // ponytail: el valor se toma al costo de hoy; el libro de movimientos no
  // guarda costo. Con el promedio ponderado del #3 es el costo vigente del
  // producto — si algún día se necesita el histórico exacto, va una columna
  // `unit_cost` en stock_movements.
  const adjustments = await prisma.$queryRaw`
    SELECT COALESCE(m.group_id::text, m.id::text) AS key,
           MIN(m.created_at)      AS date,
           MIN(m.branch_id::text) AS branch_id,
           MIN(m.reason::text)    AS reason,
           SUM(m.qty * p.cost)    AS value
    FROM stock_movements m
    JOIN products p ON p.id = m.product_id
    JOIN branches b ON b.id = m.branch_id
    WHERE b.company_id = ${companyId}::uuid
      AND m.reason IN ('MANUAL_ADJUST', 'COUNT_ADJUST')
      AND NOT EXISTS (
        SELECT 1 FROM journal_entries je
        WHERE je.company_id = ${companyId}::uuid
          AND je.source_type = 'STOCK_ADJUSTMENT'
          AND je.source_id = COALESCE(m.group_id::text, m.id::text)
      )
    GROUP BY 1
    ORDER BY 2 ASC
    LIMIT ${BATCH}
  `
  for (const adj of adjustments) {
    const esConteo = adj.reason === 'COUNT_ADJUST'
    const label = `${esConteo ? 'Ajuste por conteo' : 'Ajuste de inventario'} (${adj.key.slice(0, 8)})`
    const value = costBase(round2(Number(adj.value || 0)))
    if (value === 0) { track(label, 'valor 0'); continue }
    // Sobrante: entra inventario. Merma: sale. En ambos casos la contrapartida
    // es el costo de lo vendido.
    // ponytail: cuentas propias de merma y sobrante si se quieren separadas en
    // el estado de resultados; hoy no existen en el mapeo por defecto y
    // agregarlas obligatorias rompería a toda empresa ya configurada.
    const monto = Math.abs(value)
    const lines = value > 0
      ? [
          { account_id: defaults.inventory.id, debit: monto, credit: 0 },
          { account_id: defaults.cogs.id, debit: 0, credit: monto },
        ]
      : [
          { account_id: defaults.cogs.id, debit: monto, credit: 0 },
          { account_id: defaults.inventory.id, debit: 0, credit: monto },
        ]
    const reason = await tryPost(prisma, () => ({
      company_id: companyId,
      branch_id: adj.branch_id,
      date: adj.date,
      description: esConteo ? 'Ajuste por conteo de inventario' : 'Ajuste de inventario',
      source_type: 'STOCK_ADJUSTMENT',
      source_id: adj.key,
      created_by: userId,
      lines,
    }))
    track(label, reason)
  }

  // ---- Compras PAID sin abonos (flujo viejo): pago sintético por el total ----
  const esperaPagoSintetico = new Set(pendingSynthPayments)
  for (const purchase of purchases) {
    if (purchase.payment_status !== 'PAID' || purchase.paymentEntries.length > 0) continue
    const synthId = `pm-synth:${purchase.id}`
    if (!esperaPagoSintetico.has(synthId)) continue
    const total = round2(purchase.items.reduce((s, i) => s + i.quantity * Number(i.unit_cost), 0))
    if (total <= 0) continue
    const label = `Pago compra a ${purchase.supplier?.name || 'proveedor'} (${purchase.id.slice(0, 8)})`
    const reason = await tryPost(prisma, () => ({
      company_id: companyId,
      branch_id: purchase.branch_id,
      date: purchase.paid_at || purchase.date,
      description: `Pago compra a ${purchase.supplier?.name || 'proveedor'}`,
      source_type: 'PURCHASE_PAYMENT',
      source_id: synthId,
      created_by: userId,
      lines: [
        { account_id: defaults.payables.id, debit: total, credit: 0 },
        { account_id: defaults.cash.id, debit: 0, credit: total },
      ],
    }))
    track(label, reason)
  }

  // ---- Diferencias de arqueo (cierres de caja aprobados) ----
  // Cuentas propias (getCashClosureAccounts) y por eso se resuelven DENTRO de
  // cada tryPost, no una vez arriba como `defaults`: si una empresa no las
  // configuró, que se omitan solo estas líneas — no el resto de la corrida,
  // que ya pudo haber contabilizado ventas y compras antes de llegar aquí.
  const pendingClosures = await pendingIds(prisma, 'CASH_CLOSURE', companyId, Prisma.sql`
    SELECT cc.id::text AS id, cc.date AS ord
    FROM cash_closures cc
    JOIN branches b ON b.id = cc.branch_id
    WHERE b.company_id = ${companyId}::uuid AND cc.status = 'Aprobado'
  `)
  const closures = await prisma.cashClosure.findMany({
    where: { id: { in: pendingClosures } },
    select: { id: true, closure_number: true, branch_id: true, date: true, difference: true },
    orderBy: { date: 'asc' },
  })
  for (const closure of closures) {
    const label = `Arqueo #${closure.closure_number}`
    const diff = round2(Number(closure.difference))
    if (diff === 0) { track(label, 'diferencia 0'); continue }
    const monto = Math.abs(diff)
    const reason = await tryPost(prisma, async (tx) => {
      const acc = await getCashClosureAccounts(tx, companyId)
      // Sobrante (actual > teórico): entra más efectivo del que dice el libro.
      // Faltante: al revés. En ambos casos la contrapartida es la cuenta de
      // diferencia de caja (ingreso si sobra, gasto si falta — el signo del
      // monto en la cuenta lo distingue en el estado de resultados).
      const lines = diff > 0
        ? [
            { account_id: acc.cash.id, debit: monto, credit: 0 },
            { account_id: acc.cashOverShort.id, debit: 0, credit: monto },
          ]
        : [
            { account_id: acc.cashOverShort.id, debit: monto, credit: 0 },
            { account_id: acc.cash.id, debit: 0, credit: monto },
          ]
      return {
        company_id: companyId,
        branch_id: closure.branch_id,
        date: closure.date,
        description: `Diferencia de arqueo — ${label}`,
        source_type: 'CASH_CLOSURE',
        source_id: closure.id,
        created_by: userId,
        lines,
      }
    })
    track(label, reason)
  }

  // Una tanda llena significa que quedaron operaciones sin contabilizar: la
  // siguiente corrida las toma, en vez de que una sola muera por timeout.
  const hasMore = [
    pendingSales, pendingReturns, pendingPurchases, pendingSynthPayments, pendingPayments, adjustments,
    pendingClosures,
  ].some((a) => a.length >= BATCH)

  return { posted, skipped, hasMore }
}

module.exports = { postPendingOperations }
