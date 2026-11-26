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
 * Cuentas por cobrar: saldo de una venta al crédito, aplicación FIFO de un
 * cobro y control de límite de crédito.
 *
 * El saldo NO se guarda en ninguna columna: es `adjusted_total − Σ abonos`.
 * Se usa `adjusted_total` y no `total` porque ya viene neteado de devoluciones,
 * así que devolver mercadería de una venta al crédito baja la deuda sola.
 * `sales.payment_status` es solo denormalización para poder filtrar e indexar.
 */

const { round2 } = require('../../../services/accounting/logic')
const {allocationForReceipt,allocationSelect,hydrateReceiptAllocations}=require('./paymentAllocations')
const {confirmedSaleWhere,CONFIRMED_SALE_STATUS}=require('../../sales/commercialState')
const Charges=require('./chargeDocuments')

/** Mismo epsilon que compras: por debajo de medio centavo se considera saldado. */
const ROUND_EPS = 0.005

/**
 * Espacio de advisory locks de cartera. Se serializa por cliente para que dos
 * cobros simultáneos no lean el mismo saldo y apliquen de más (dejando la venta
 * con abonos por encima de su total). Se libera solo al terminar la transacción.
 */
const RECEIVABLE_LOCK_NS = 910005

async function lockCustomer(tx, customerId) {
  // Los casts son obligatorios: Prisma manda los parámetros como bigint y la
  // variante de dos claves de pg_advisory_xact_lock solo existe para int4.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${RECEIVABLE_LOCK_NS}::int4, hashtext(${customerId})::int4)`
}

class ReceivableError extends Error {
  constructor(message, status = 400, details = undefined) {
    super(message)
    this.name = 'ReceivableError'
    this.status = status
    if (details) this.details = details
  }
}

/** Estado de cobro según el total de la venta y lo abonado. */
function statusFor(total, paid) {
  if (paid >= total - ROUND_EPS) return 'PAID'
  if (paid > ROUND_EPS) return 'PARTIAL'
  return 'PENDING'
}

/** Suma de los abonos aplicados a una venta. */
function paidOf(sale) {
  return round2((sale.paymentEntries || []).reduce((s, e) => s + Number(e.amount), 0))
}

/** Saldo pendiente de una venta: lo que debe menos lo que ya abonó. */
function balanceOf(sale) {
  return round2(Number(sale.adjusted_total) - paidOf(sale))
}

/**
 * Reparte `amount` entre las ventas abiertas, de la más vieja a la más nueva.
 * `openSales` debe venir ya ordenada y con `{ id, balance }`.
 *
 * Lo que sobra queda como `unapplied` (anticipo / saldo a favor del cliente) en
 * vez de rechazarse: el cajero no puede negarse a recibir un billete de más.
 * Ese sobrante se aplica después con `applyAvailableCredit`.
 */
function planFifo(openSales, amount) {
  let remaining = round2(amount)
  if (!Number.isFinite(remaining) || remaining <= 0) {
    throw new ReceivableError('El monto del cobro debe ser mayor a 0')
  }

  const applications = []
  for (const sale of openSales) {
    if (remaining <= ROUND_EPS) break
    const take = round2(Math.min(remaining, sale.balance))
    if (take <= 0) continue
    applications.push(sale.documentType === 'DISPUTE_CHARGE' ? { documentType: 'DISPUTE_CHARGE', documentId: sale.id, amount: take } : { sale_id: sale.id, amount: take })
    remaining = round2(remaining - take)
  }
  return { applications, unapplied: round2(Math.max(0, remaining)) }
}

/**
 * Aplicación manual: el cajero dice a qué facturas va el dinero («este cheque
 * es de la factura 120»). Valida contra las ventas abiertas reales, no contra
 * lo que la UI creía: entre que se dibujó la pantalla y llegó el POST pudo
 * entrar otro cobro o una devolución.
 */
function planManual(openSales, requested, amount) {
  const total = round2(amount)
  if (!Number.isFinite(total) || total <= 0) {
    throw new ReceivableError('El monto del cobro debe ser mayor a 0')
  }
  // Un cargo por contracargo y una venta pueden compartir cobro; cada documento se identifica por su tipo.
  const keyOf = (type, id) => `${type}:${id}`
  const byId = new Map(openSales.map((s) => [keyOf(s.documentType || 'SALE', s.id), s]))
  const applications = []
  const vistas = new Set()
  let asignado = 0

  for (const raw of requested) {
    const type = raw?.documentType || 'SALE'
    if (!['SALE', 'DISPUTE_CHARGE'].includes(type)) throw new ReceivableError('Tipo de documento inválido')
    const saleId = String((type === 'SALE' ? raw?.sale_id ?? raw?.documentId : raw?.documentId) || '')
    const monto = round2(Number(raw?.amount))
    if (!saleId) throw new ReceivableError('Cada aplicación necesita una venta o cargo')
    if (vistas.has(keyOf(type, saleId))) {
      throw new ReceivableError('Un mismo documento no puede aparecer dos veces en el cobro')
    }
    vistas.add(keyOf(type, saleId))
    if (!Number.isFinite(monto) || monto <= 0) {
      throw new ReceivableError('El monto aplicado a cada venta debe ser mayor a 0')
    }
    const sale = byId.get(keyOf(type, saleId))
    if (!sale) {
      throw new ReceivableError(type === 'SALE' ? 'Una de las ventas seleccionadas ya no tiene saldo pendiente' : 'Uno de los cargos seleccionados ya no tiene saldo pendiente', 409)
    }
    if (monto > sale.balance + ROUND_EPS) {
      throw new ReceivableError(
        `El monto aplicado a ${sale.reference || 'la venta'} excede su saldo (${sale.balance.toFixed(2)})`,
        400,
        { sale_id: saleId, saldo: sale.balance, monto }
      )
    }
    applications.push(type === 'SALE' ? { sale_id: saleId, amount: monto } : { documentType: type, documentId: saleId, amount: monto })
    asignado = round2(asignado + monto)
  }

  if (asignado > total + ROUND_EPS) {
    throw new ReceivableError(
      `Lo aplicado a las facturas (${asignado.toFixed(2)}) excede el monto del cobro (${total.toFixed(2)})`,
      400
    )
  }
  return { applications, unapplied: round2(Math.max(0, total - asignado)) }
}

/**
 * Ventas al crédito abiertas de un cliente, de la más vieja a la más nueva.
 * El orden es el que consume el FIFO: primero la que vence antes; las que no
 * tienen vencimiento van por fecha de venta.
 */
async function openSalesOf(db, customerId, branchWhereClause = {}) {
  const sales = await db.sale.findMany({
    where: confirmedSaleWhere({
      customer_contact_id: customerId,
      payment_status: { in: ['PENDING', 'PARTIAL'] },
      payment_method: { is_credit: true },
      ...branchWhereClause,
    }),
    select: {
      id: true, reference: true, date: true, due_date: true,
      adjusted_total: true, payment_status: true,
      paymentEntries: { select: { amount: true } },
    },
    orderBy: [{ due_date: 'asc' }, { date: 'asc' }],
  })
  return sales
    .map((s) => ({ ...s, balance: balanceOf(s) }))
    .filter((s) => s.balance > ROUND_EPS)
}

/**
 * Documentos por cobrar: ventas al crédito y cargos por contracargo, en el orden
 * que consume el FIFO (vence antes; sin vencimiento, por fecha del documento).
 */
async function openDocumentsOf(db, customerId, branchWhereClause = {}, options = {}) {
  const [sales, charges] = await Promise.all([openSalesOf(db, customerId, branchWhereClause), Charges.openChargesOf(db, customerId, branchWhereClause, options)])
  const when = d => new Date(d.due_date || d.date || 0).getTime()
  return [...sales.map(s => ({ ...s, documentType: 'SALE' })), ...charges]
    .sort((a, b) => when(a) - when(b) || new Date(a.date || 0) - new Date(b.date || 0) || String(a.id).localeCompare(String(b.id)))
}

/** Recalcula `payment_status` de una venta desde sus abonos. */
async function syncSaleStatus(tx, saleId) {
  const sale = await tx.sale.findUnique({
    where: { id: saleId },
    select: { id: true, status:{select:{name:true}},adjusted_total: true, paymentEntries: { select: { amount: true } } },
  })
  if (!sale) return
  if(sale.status?.name!==CONFIRMED_SALE_STATUS)throw Object.assign(new ReceivableError('Confirma la venta antes de aplicar cobros',409),{code:'SALE_NOT_CONFIRMED'})
  const status = statusFor(Number(sale.adjusted_total), paidOf(sale))
  await tx.sale.update({ where: { id: saleId }, data: { payment_status: status } })
}

/** Plan mínimo para soltar abonos que quedaron por encima del nuevo total. */
function planApplicationRelease(entries, amount) {
  let pending = round2(amount)
  if (!Number.isFinite(pending) || pending < 0) throw new ReceivableError('Monto a liberar inválido')
  const ordered = [...(entries || [])].sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
  const plan = []
  for (const entry of ordered) {
    if (pending <= ROUND_EPS) break
    const current = round2(entry.amount)
    const release = round2(Math.min(current, pending))
    if (release <= 0) continue
    plan.push({ id: entry.id, release, remaining: round2(current - release) })
    pending = round2(pending - release)
  }
  if (pending > ROUND_EPS) throw new ReceivableError('El monto a liberar excede los abonos aplicados', 409)
  return plan
}

/** Devuelve a saldo a favor la parte de abonos que ya excede el total ajustado. */
async function releaseSaleOverpayment(tx, saleId, amount, resolution=null) {
  return (await releaseSaleOverpaymentWithPlan(tx,saleId,amount,resolution)).released
}
async function releaseSaleOverpaymentWithPlan(tx, saleId, amount, resolution=null) {
  const source=await tx.sale.findUnique({where:{id:saleId},select:{appointment_engagement:{select:{id:true,company_id:true,branch_id:true,customer_id:true}}}})
  if(source?.appointment_engagement&&amount>ROUND_EPS){
    if(!resolution)throw Object.assign(new ReceivableError('Decide si el dinero vuelve a la contratación o al saldo libre antes de liberar el abono',409),{code:'ENGAGEMENT_RESOLUTION_REQUIRED'})
    const released=await require('../engagementPayments').releaseEngagementSaleOverpayment(tx,source.appointment_engagement,saleId,amount,resolution)
    return {released,allocations:[]}
  }
  const entries = await tx.salePaymentEntry.findMany({
    where: { sale_id: saleId },
    select: { id: true, customer_payment_id:true, amount: true, created_at: true },
    orderBy: { created_at: 'desc' },
  })
  const plan = planApplicationRelease(entries, amount)
  const allocations=plan.map(item=>({paymentId:entries.find(e=>e.id===item.id).customer_payment_id,amount:item.release.toFixed(2)}))
  for (const item of plan) {
    if (item.remaining <= ROUND_EPS) await tx.salePaymentEntry.delete({ where: { id: item.id } })
    else await tx.salePaymentEntry.update({ where: { id: item.id }, data: { amount: item.remaining } })
  }
  await syncSaleStatus(tx, saleId)
  return {released:round2(plan.reduce((sum,item)=>sum+item.release,0)),allocations}
}

/**
 * Cobros del cliente con dinero todavía sin aplicar a ninguna factura: el saldo
 * a favor. Se deriva igual que la deuda (`amount − Σ aplicaciones`) para no
 * tener dos números que puedan desincronizarse.
 */
async function receiptBalances(db, customerId, branchWhereClause = {}) {
  const payments = await db.customerPayment.findMany({
    where: { customer_id: customerId, ...branchWhereClause },
    select: {
      id: true, amount: true, paid_at: true, kind: true, reference: true,
      ...allocationSelect,
    },
    orderBy: { paid_at: 'asc' },
  })
  return (await hydrateReceiptAllocations(db,payments))
    .map(p=>{const allocation=allocationForReceipt(p);return {...p,allocation,unapplied:Number(allocation.available)}})
}
async function unappliedPayments(db, customerId, branchWhereClause = {}) {
  return (await receiptBalances(db,customerId,branchWhereClause)).filter(p=>p.unapplied>ROUND_EPS)
}

/** Saldo a favor total del cliente. */
async function availableCredit(db, customerId, branchWhereClause = {}) {
  const credits = await unappliedPayments(db, customerId, branchWhereClause)
  return round2(credits.reduce((s, c) => s + c.unapplied, 0))
}

/**
 * Saldo total, vencido y a favor de un cliente.
 *
 * `saldo_neto` es lo que realmente debe: la deuda menos los anticipos que aún
 * no se han aplicado. Es el número que mira el límite de crédito, porque un
 * cliente que ya dejó el dinero adelantado no está expuesto.
 */
async function customerBalance(db, customerId, branchWhereClause = {}, now = new Date()) {
  const [open, funds, charges, recoveries] = await Promise.all([
    openSalesOf(db, customerId, branchWhereClause),
    receiptBalances(db, customerId, branchWhereClause),
    Charges.openChargesOf(db, customerId, branchWhereClause),
    Charges.recoveryCreditsOf(db, customerId, branchWhereClause),
  ])
  const credito=round2(funds.reduce((sum,p)=>sum+p.unapplied,0))
  const recuperacion=round2(recoveries.reduce((sum,c)=>sum+c.available,0))
  const held=round2(funds.reduce((sum,p)=>sum+Number(p.allocation.held||0),0))
  const vencidas = open.filter((s) => s.due_date && new Date(s.due_date) < now)
  const cargosVencidos = charges.filter(c => Charges.chargeOverdue(c.due_date, now))
  const documentos = [...open, ...charges], vencidos = [...vencidas, ...cargosVencidos]
  const saldo = round2(documentos.reduce((s, v) => s + v.balance, 0))
  return {
    saldo,
    vencido: round2(vencidos.reduce((s, v) => s + v.balance, 0)),
    vencido_30_mas: round2(vencidos.filter(v => Math.floor((now - new Date(v.due_date)) / 86400000) > 30).reduce((s, v) => s + v.balance, 0)),
    facturas_abiertas: open.length,
    facturas_vencidas: vencidas.length,
    cargos_abiertos: charges.length,
    cargos_vencidos: cargosVencidos.length,
    cargos_saldo: round2(charges.reduce((s, c) => s + c.balance, 0)),
    documentos_abiertos: documentos.length,
    documentos_vencidos: vencidos.length,
    credito_disponible: credito,
    credito_recuperacion: recuperacion,
    credito_en_revision: held,
    saldo_neto: round2(Math.max(0, saldo - credito - recuperacion)),
  }
}

/**
 * Término de pago que manda para un cliente: el marcado como predeterminado y,
 * si ninguno lo está, el primero — igual que la ficha del contacto.
 *
 * Vive acá porque lo usan la venta (para calcular el vencimiento) y el POS
 * (para mostrarlo antes de vender): si difieren, la pantalla promete una fecha
 * y la venta guarda otra. Antes filtraban por `is_default: true` y un cliente
 * con término sin marcar quedaba como si no tuviera ninguno.
 */
const CUSTOMER_TERM_PICK = {
  select: { payment_term: { select: { name: true, net_days: true } } },
  orderBy: [{ is_default: 'desc' }, { sort_order: 'asc' }],
  take: 1,
}

/**
 * Verifica si un cliente puede llevarse `amount` al crédito.
 *
 * Bloquea por límite excedido o por tener facturas vencidas. Devuelve siempre
 * el detalle para que la UI pueda explicarlo y ofrecer la autorización a quien
 * tenga `sales.credit.override`.
 */
async function checkCredit(db, customer, amount, branchWhereClause = {}, now = new Date()) {
  const { saldo, vencido, facturas_vencidas, cargos_vencidos, credito_disponible, saldo_neto } =
    await customerBalance(db, customer.id, branchWhereClause, now)
  const nuevo = round2(saldo_neto + round2(amount))
  const limite = customer.credit_limit == null ? null : round2(Number(customer.credit_limit))

  const razones = []
  if (facturas_vencidas > 0 || cargos_vencidos > 0) {
    const partes = [facturas_vencidas ? `${facturas_vencidas} factura(s)` : null, cargos_vencidos ? `${cargos_vencidos} cargo(s) por contracargo` : null].filter(Boolean)
    razones.push(`tiene ${partes.join(' y ')} vencido(s) por ${vencido.toFixed(2)}`)
  }
  if (limite != null && nuevo > limite + ROUND_EPS) {
    razones.push(`excede su límite de ${limite.toFixed(2)} por ${round2(nuevo - limite).toFixed(2)}`)
  }

  return {
    ok: razones.length === 0,
    saldo_actual: saldo,
    saldo_neto,
    credito_disponible,
    saldo_resultante: nuevo,
    limite,
    vencido,
    facturas_vencidas,
    cargos_vencidos,
    motivo: razones.length ? `El cliente ${razones.join(' y ')}` : null,
  }
}

/**
 * Crea un cobro y lo aplica FIFO, dentro de la transacción que se le pase.
 *
 * Vive acá y no en el controller para que se pueda probar contra una base real
 * sin levantar Express: es la secuencia que mueve dinero.
 */
async function applyPayment(tx, params) {
  const {
    customerId, branchId, amount, paidAt, paymentMethodId, cashRegisterSessionId,
    reference, notes, userId, kind = 'PAYMENT', manualApplications = null,
    allowAdvance = false,
  } = params

  let cash = false
  let session = null
  if (kind === 'PAYMENT') {
    const method = await require('../../../services/paymentMethods/access').resolvePaymentMethod(tx, { companyId: params.companyId, methodId: paymentMethodId, purpose: 'RECEIPT' })
    cash = require('../../../services/paymentMethods/behavior').isCashMethod(method, name => /efectivo|cash/i.test(name))
    if (cash && !cashRegisterSessionId) throw Object.assign(new ReceivableError('Abre tu turno de caja antes de recibir efectivo', 409), { code: 'CASH_SESSION_REQUIRED' })
    if (cashRegisterSessionId) {
      const boundary = require('../../../services/cashSessionBoundary')
      session = await boundary.lockScopedSession(tx, { companyId: params.companyId, branchId, userId }, cashRegisterSessionId)
      if (session.money_event_version === 1 && params.externalRequest && !params.requestAttempt?.key) throw Object.assign(new ReceivableError('Actualiza la pantalla para obtener una clave segura antes de cobrar.', 428), { code: 'PAYMENT_KEY_REQUIRED' })
      boundary.assertSessionOperation(session, { userId, isAdmin: params.isAdmin }, { settlementKind: method.settlement_kind ?? (cash ? 'CASH' : null) })
    }
  }
  await lockCustomer(tx, customerId)

  // Las ventas se releen dentro de la transacción (y después del lock): el saldo
  // pudo cambiar entre el momento en que la UI lo mostró y este cobro.
  // Un ajuste de cartera no condona cargos por contracargo: eso se resuelve en su expediente.
  const open = kind === 'PAYMENT' ? await openDocumentsOf(tx, customerId, { branch_id: branchId }, { lock: true }) : await openSalesOf(tx, customerId, { branch_id: branchId })
  const { applications, unapplied } = manualApplications?.length
    ? planManual(open, manualApplications, amount)
    : planFifo(open, amount)

  // Un ajuste no es dinero: no puede quedar como saldo a favor del cliente.
  // Perdonar más de lo que debe sería regalarle crédito que nadie pagó.
  if (kind !== 'PAYMENT' && unapplied > ROUND_EPS) {
    throw new ReceivableError(
      `El ajuste excede el saldo del cliente (pendiente ${round2(amount - unapplied).toFixed(2)})`,
      400,
      { saldo_pendiente: round2(amount - unapplied), monto: round2(amount) }
    )
  }

  // Dejar dinero sin aplicar tiene que ser una decisión, no un accidente: casi
  // siempre es el mismo cobro enviado dos veces, no un anticipo de verdad. Se
  // rechaza acá dentro para que la transacción no deje el pago a medias.
  if (kind === 'PAYMENT' && unapplied > ROUND_EPS && !allowAdvance) {
    throw new ReceivableError(
      `El cobro excede el saldo del cliente (pendiente ${round2(amount - unapplied).toFixed(2)}). `.trim() +
      'Confirme que los ' + unapplied.toFixed(2) + ' de más quedan como anticipo.',
      409,
      { saldo_pendiente: round2(amount - unapplied), monto: round2(amount), sobrante: unapplied, requiere_anticipo: true }
    )
  }

  const payment = await tx.customerPayment.create({
    data: {
      branch_id: branchId,
      customer_id: customerId,
      amount: round2(amount),
      paid_at: paidAt || new Date(),
      kind,
      payment_method_id: paymentMethodId || null,
      cash_register_session_id: cashRegisterSessionId || null,
      reference: reference || null,
      notes: notes || null,
      registered_by: userId,
      applications: { create: applications.filter(a => a.sale_id).map((a) => ({ sale_id: a.sale_id, amount: a.amount })) },
    },
    select: { id: true },
  })
  const chargeApplications = applications.filter(a => a.documentType === 'DISPUTE_CHARGE')
  if (chargeApplications.length) await Charges.applyReceiptToCharges(tx, { companyId: params.companyId, branchId, userId }, { paymentId: payment.id, customerId, applications: chargeApplications })

  if (kind === 'PAYMENT' && params.requestAttempt) await require('../paymentAttempts').savePaymentAttempt(tx, payment.id, params.requestAttempt)
  for (const a of applications) if (a.sale_id) await syncSaleStatus(tx, a.sale_id)
  if (kind === 'PAYMENT' && session) await require('../../cash-closure/events').recordMoneyEvent(tx, { companyId: params.companyId, branchId, userId, isAdmin: params.isAdmin }, { session, sourceType: 'CUSTOMER_PAYMENT', sourceId: payment.id })
  if(kind==='PAYMENT'&&cash&&params.hardware)await require('../../config/hardware/drawer/events').enqueueDrawerIntent(tx,params.hardware.scope,{origin:params.hardware.origin,sourceId:payment.id,workstationId:params.hardware.workstationId})
  return { paymentId: payment.id, applications, unapplied }
}

/**
 * Aplica el saldo a favor del cliente a sus facturas abiertas, del anticipo más
 * viejo a la factura más vieja. No mueve dinero ni genera asiento: ese dinero ya
 * entró y ya se contabilizó cuando se recibió el cobro; esto solo lo reparte.
 */
async function applyAvailableCredit(tx, customerId, branchId, scope = null) {
  await lockCustomer(tx, customerId)
  // Sin actor no se pueden registrar aplicaciones a cargos: se conserva el reparto anterior, solo ventas.
  const [open, credits, recoveries] = await Promise.all([
    scope ? openDocumentsOf(tx, customerId, { branch_id: branchId }, { lock: true }) : openSalesOf(tx, customerId, { branch_id: branchId }),
    unappliedPayments(tx, customerId, { branch_id: branchId }),
    scope ? Charges.recoveryCreditsOf(tx, customerId, { branch_id: branchId }) : [],
  ])
  const chargeScope = scope && { companyId: scope.companyId, branchId, userId: scope.userId }

  const applied = []
  // El crédito de recuperación solo cubre cargos por contracargo; se usa antes que el dinero de los recibos.
  for (const credit of recoveries) {
    let left = credit.available
    for (const doc of open.filter(d => d.documentType === 'DISPUTE_CHARGE')) {
      if (left <= ROUND_EPS) break
      if (doc.balance <= ROUND_EPS) continue
      const take = round2(Math.min(left, doc.balance))
      await Charges.applyRecoveryCreditToCharge(tx, chargeScope, { creditId: credit.id, chargeId: doc.id, customerId, amount: take })
      doc.balance = round2(doc.balance - take)
      left = round2(left - take)
      applied.push({ documentType: 'DISPUTE_CHARGE', documentId: doc.id, recovery_credit_id: credit.id, amount: take })
    }
  }
  for (const credit of credits) {
    let left = credit.unapplied
    for (const sale of open) {
      if (left <= ROUND_EPS) break
      if (sale.balance <= ROUND_EPS) continue
      const take = round2(Math.min(left, sale.balance))
      if (sale.documentType === 'DISPUTE_CHARGE') {
        await Charges.applyReceiptToCharges(tx, chargeScope, { paymentId: credit.id, customerId, applications: [{ documentId: sale.id, amount: take }] })
        applied.push({ documentType: 'DISPUTE_CHARGE', documentId: sale.id, payment_id: credit.id, amount: take })
      } else {
        await tx.salePaymentEntry.create({
          data: { sale_id: sale.id, customer_payment_id: credit.id, amount: take },
        })
        applied.push({ sale_id: sale.id, payment_id: credit.id, amount: take })
      }
      sale.balance = round2(sale.balance - take)
      left = round2(left - take)
    }
  }
  if (recoveries.length && applied.some(a => a.recovery_credit_id)) await Charges.refreshChargeOrigins(tx, chargeScope, [...new Set(applied.filter(a => a.recovery_credit_id).map(a => a.documentId))])

  for (const saleId of new Set(applied.filter(a => a.sale_id).map((a) => a.sale_id))) {
    await syncSaleStatus(tx, saleId)
  }
  return applied
}

/** Rangos de antigüedad de un saldo, en días vencidos. */
function agingBucket(dueDate, now = new Date()) {
  if (!dueDate) return 'corriente'
  const dias = Math.floor((now - new Date(dueDate)) / 86400000)
  if (dias <= 0) return 'corriente'
  if (dias <= 30) return 'd1_30'
  if (dias <= 60) return 'd31_60'
  if (dias <= 90) return 'd61_90'
  return 'd90_mas'
}

module.exports = {
  ROUND_EPS,
  ReceivableError,
  statusFor,
  paidOf,
  balanceOf,
  planFifo,
  planManual,
  openSalesOf,
  openDocumentsOf,
  syncSaleStatus,
  planApplicationRelease,
  releaseSaleOverpayment,
  releaseSaleOverpaymentWithPlan,
  customerBalance,
  unappliedPayments,
  availableCredit,
  checkCredit,
  CUSTOMER_TERM_PICK,
  applyPayment,
  applyAvailableCredit,
  lockCustomer,
  agingBucket,
}
