const { DateTime } = require('luxon')
const { createHash } = require('node:crypto')
const { getTimezone } = require('../../utils/getTimezone')
const { applyOpeningFloatToCashBreakdown, applyReturnSettlements } = require('./domain')
const { closureScope: checkClosureScopePermission } = require('./access')
const { requireBranch } = require('../../middlewares/tenant')
const number = v => Number(v) || 0
const failure = (status, message) => Object.assign(new Error(message), { status })

function calculationKey(req, data) {
  const methods = data.payment_breakdown.map(m => [m.payment_method_id, m.settlement_kind, m.theoretical_amount, m.theoretical_count, m.breakdown_key]).sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  const sources = [...data.collections.map(r => ['receipt',r.id,String(r.amount)]), ...data.return_settlements.map(r => ['return',r.id,r.kind,String(r.amount)]), ...data.advance_refunds.map(r => ['advance-refund',r.id,String(r.amount)])].sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  return createHash('sha256').update(JSON.stringify([req.companyId, req.branchId, req.user?.sub, data.period, data.theoretical, methods, data.metrics, data.unidentified_collections_amount, sources, data.calculation_basis, data.event_hash, data.cash_session, data.currency_code])).digest('hex')
}

async function calculateTheoreticalData(prisma, req) {
    // Compatibilidad con los nombres de filtro de los clientes existentes.
    const startDate = req.query.startDate || req.query.start_date
    const endDate = req.query.endDate || req.query.end_date
    const cashierId = req.query.cashier_id || req.query.cashierId || null
    const cashRegisterSessionIdRaw =
      req.query.cash_register_session_id || req.query.cashRegisterSessionId || null
    const cashRegisterSessionId = cashRegisterSessionIdRaw
      ? String(cashRegisterSessionIdRaw).trim()
      : null

    // Permiso según tipo de cierre: día (sin cashier_id) vs propio (con cashier_id)
    const isOwn = !!cashierId
    const permCheck = checkClosureScopePermission(req, isOwn)
    if (!permCheck.allowed) {
      throw failure(permCheck.status || 403, permCheck.message || 'No autorizado')
    }
    if (isOwn && req.user?.sub && cashierId !== req.user.sub) {
      throw failure(403, 'Solo puede generar el cierre de su propia caja')
    }

    const available = await require('./eventStorage').ledgerAvailable(prisma)
    const eventReader = require('./eventTheoretical')
    const tz = await getTimezone(prisma, req.companyId)
    let start
    let end
    let sessionOpeningFloat = 0

    if (isOwn) {
      if (!cashRegisterSessionId) {
        throw failure(400, 'Para «mi cierre» debe enviar cash_register_session_id (turno ya cerrado en «Nueva venta», pendiente de arqueo).')
      }
      let sess = await prisma.cashRegisterSession.findFirst({
        where: { id: cashRegisterSessionId, cashRegister: { branch_id: requireBranch(req), branch: { company_id: req.companyId } } }
      })
      if (!sess) {
        throw failure(404, 'Sesión de caja no encontrada')
      }
      if (String(sess.opened_by_id) !== String(cashierId)) {
        const { hasPerm } = require('../../middlewares/tenant')
        if (sess.operation_mode !== 'SHARED' || !(hasPerm(req.user, 'cashclosure.create') || hasPerm(req.user, 'cashclosure.create_day'))) throw failure(403, 'Solo el responsable o un encargado puede contar este turno compartido')
      }
      if (sess.status !== 'CLOSED') {
        throw failure(400, 'El turno debe estar cerrado en «Nueva venta» (fin de turno) antes de calcular el cierre. Mientras la caja siga abierta no se puede arquear.')
      }
      // Un arqueo en reconteo (3C) admite el arqueo sustituto del mismo turno.
      if (sess.cash_closure_id && (await prisma.$queryRaw`SELECT to_jsonb(c)->>'status' AS status FROM cash_closures c WHERE id=${sess.cash_closure_id}::uuid`)[0]?.status !== 'Reconteo') {
        throw failure(400, 'Este turno de caja ya tiene un cierre de caja registrado.')
      }
      if (!sess.closed_at) {
        throw failure(400, 'La sesión no tiene fecha de cierre; no se puede calcular.')
      }
      if (available) sess = (await require('../../services/cashMetadata').hydrateCashMetadata(prisma, [sess]))[0]
      if (sess.money_event_version === 1) {
        const result = await eventReader.calculateEventTheoretical(prisma, { companyId: req.companyId, branchId: requireBranch(req) }, { session: sess, start: sess.opened_at, end: sess.closed_at })
        result.calculation_key = calculationKey(req, result)
        return result
      }
      sessionOpeningFloat = number(sess.opening_float)
      // Fuente de verdad: horas del turno en BD (evita desajuste con sold_at vs strings del formulario)
      start = sess.opened_at
      end = sess.closed_at
    } else {
      if (typeof startDate !== 'string' || typeof endDate !== 'string' || !startDate || !endDate) {
        throw failure(400, 'startDate y endDate son requeridos')
      }
      if (startDate.includes('Z')) {
        start = DateTime.fromISO(startDate, { zone: 'utc' }).setZone(tz).toJSDate()
        end = DateTime.fromISO(endDate, { zone: 'utc' }).setZone(tz).toJSDate()
      } else {
        start = DateTime.fromISO(startDate, { zone: tz }).toJSDate()
        end = DateTime.fromISO(endDate, { zone: tz }).toJSDate()
      }
    }

    if (!start || !end || isNaN(start.getTime()) || isNaN(end.getTime()) || start >= end) {
      throw failure(400, 'Fechas inválidas')
    }
    // Obtener estado "Completada"
    const completedStatus = await prisma.saleStatus.findFirst({
      where: { name: 'Completada' }
    })

    const periodOr = {
      OR: [
        { sold_at: { gte: start, lte: end } },
        { date: { gte: start, lte: end } }
      ]
    }

    /**
     * Mi cierre con sesión: NO filtrar por sold_at/date entre opened_at y closed_at.
     * Ventas de antes de la corrección del guardado de fechas (ver sales.controller.js)
     * tienen sold_at con la hora local reetiquetada como UTC, corrida contra los
     * timestamps UTC reales de la sesión → el rango las excluye. cash_register_session_id
     * no depende de esto y sigue siendo la fuente confiable. Legado: sin sesión, sí
     * período + created_by (ahí periodOr ya compara correctamente en ventas nuevas).
     */
    let salesWhere
    if (isOwn && cashRegisterSessionId) {
      salesWhere = {
        status_id: completedStatus?.id,
        OR: [
          { cash_register_session_id: cashRegisterSessionId },
          {
            AND: [
              { cash_register_session_id: null },
              ...(cashierId ? [{ created_by: String(cashierId) }] : []),
              periodOr
            ]
          }
        ]
      }
    } else {
      salesWhere = {
        status_id: completedStatus?.id,
        ...periodOr
      }
      if (cashierId) {
        salesWhere.created_by = String(cashierId)
      }
    }

    // Obtener ventas completadas en el período (opcionalmente filtradas por cajero)
    const { branchWhere } = require('../../middlewares/tenant')
    Object.assign(salesWhere, branchWhere(req))
    salesWhere.status={name:require('../sales/commercialState').CONFIRMED_SALE_STATUS}
    // La venta al crédito no entra al arqueo: no hubo dinero que contar. Lo que
    // sí entra es el cobro posterior, más abajo.
    salesWhere.payment_method = { is_credit: false }
    salesWhere.settlement_source = 'LEGACY'
    const saleRows = await prisma.sale.findMany({
      where: salesWhere,
      include: {
        payment_method: true,
        replacement_for_return: { select: { id: true } },
      }
    })
    // La venta vinculada de un cambio no es una entrada de caja por su total:
    // el cliente solo paga (o recibe) la diferencia, registrada en settlements.
    const sales = (available && !isOwn ? await eventReader.legacyRows(prisma, saleRows) : saleRows).filter((sale) => !sale.replacement_for_return)

    // Calcular totales teóricos
    let theoreticalSales = 0
    let theoreticalReturns = 0
    const paymentMethodsMap = new Map()

    for (const sale of sales) {
      theoreticalSales += number(sale.total)

      // Agrupar por método de pago
      const methodKey = sale.payment_method_id
      const methodName = sale.payment_method.name
      
      if (!paymentMethodsMap.has(methodKey)) {
        paymentMethodsMap.set(methodKey, {
          id: methodKey,
          name: methodName,
          settlement_kind:sale.payment_method.settlement_kind??null,
          theoretical_amount: 0,
          theoretical_count: 0,
          sales: []
        })
      }

      const method = paymentMethodsMap.get(methodKey)
      method.theoretical_amount += number(sale.total)
      method.theoretical_count += 1
      method.sales.push({
        id: sale.id,
        total: sale.total,
        adjusted_total: sale.total,
        returned: 0
      })
    }

    /**
     * Cobros de clientes del período: dinero que entró sin ser una venta de hoy
     * (canceló una venta al crédito anterior). Sin esto el cajero cuadra un
     * cajón que tiene más efectivo del que el teórico explica, y sale sobrante
     * cada vez que alguien abona.
     */
    let collectionsWhere
    if (isOwn && cashRegisterSessionId) {
      collectionsWhere = {
        OR: [
          { cash_register_session_id: cashRegisterSessionId },
          {
            AND: [
              { cash_register_session_id: null },
              ...(cashierId ? [{ registered_by: String(cashierId) }] : []),
              { paid_at: { gte: start, lte: end } }
            ]
          }
        ]
      }
    } else {
      collectionsWhere = { paid_at: { gte: start, lte: end } }
      if (cashierId) collectionsWhere.registered_by = String(cashierId)
    }
    // Solo cobros de verdad: una nota de crédito o un castigo por incobrable
    // bajan la deuda pero no meten un centavo al cajón.
    collectionsWhere.kind = 'PAYMENT'
    Object.assign(collectionsWhere, branchWhere(req))

    const collectionRows = await prisma.customerPayment.findMany({
      where: collectionsWhere,
      include: { payment_method: true, customer: { select: { name: true } } }
    })
    const collections = available && !isOwn ? await eventReader.legacyRows(prisma, collectionRows) : collectionRows

    let theoreticalCollections = 0
    let unidentifiedCollections = 0
    for (const col of collections) {
      const amount = number(col.amount)
      theoreticalCollections += amount

      const methodKey = col.payment_method_id
      if (methodKey == null || !col.payment_method) {
        unidentifiedCollections += amount
        continue
      }
      if (!paymentMethodsMap.has(methodKey)) {
        paymentMethodsMap.set(methodKey, {
          id: methodKey,
          name: col.payment_method.name,
          settlement_kind:col.payment_method.settlement_kind??null,
          theoretical_amount: 0,
          theoretical_count: 0,
          sales: []
        })
      }
      const method = paymentMethodsMap.get(methodKey)
      method.theoretical_amount += amount
      method.theoretical_count += 1
    }

    let returnSettlementWhere
    if (isOwn && cashRegisterSessionId) {
      returnSettlementWhere = { cash_register_session_id: cashRegisterSessionId, return: { sale: { ...branchWhere(req) } } }
    } else {
      returnSettlementWhere = {
        created_at: { gte: start, lte: end },
        return: { sale: { ...branchWhere(req) } },
      }
      if (cashierId) returnSettlementWhere.registered_by = String(cashierId)
    }
    returnSettlementWhere.kind = { in: ['REFUND', 'COLLECTION'] }
    const settlementRows = await prisma.returnSettlement.findMany({
      where: returnSettlementWhere,
      include: {
        payment_method: true,
        return: { select: { reference: true, sale: { select: { reference: true } } } },
      },
      orderBy: { created_at: 'asc' },
    })
    const returnSettlements = available && !isOwn ? await eventReader.legacyRows(prisma, settlementRows) : settlementRows
    const settlementTotals = applyReturnSettlements(paymentMethodsMap, returnSettlements)
    theoreticalReturns = settlementTotals.refunds
    theoreticalCollections += settlementTotals.collections

    const advanceRefundWhere={status:'CONFIRMED',...branchWhere(req),...(isOwn&&cashRegisterSessionId?{cash_register_session_id:cashRegisterSessionId}:{confirmed_at:{gte:start,lte:end},...(cashierId?{registered_by:String(cashierId)}:{})})}
    const advanceRefundRows=await prisma.customerPaymentRefund.findMany({where:advanceRefundWhere,include:{payment_method:true},orderBy:{confirmed_at:'asc'}})
    const advanceRefunds=available&&!isOwn?await eventReader.legacyRows(prisma,advanceRefundRows):advanceRefundRows
    const advanceTotals=applyReturnSettlements(paymentMethodsMap,advanceRefunds.map(refund=>({...refund,kind:'REFUND'})))
    theoreticalReturns+=advanceTotals.refunds

    // Only explicitly linked supplier outflows participate. Documentary cancellation
    // does not prove that money returned to the drawer.
    const supplierPayments = available ? await prisma.$queryRaw`SELECT p.id,p.amount,p.paid_at,p.payment_method_id,pm.name AS method_name,pm.settlement_kind
      FROM supplier_payments p JOIN cash_register_sessions s ON s.id=p.cash_register_session_id
      LEFT JOIN payment_methods pm ON pm.id=p.payment_method_id
      WHERE p.company_id=${req.companyId}::uuid AND p.branch_id=${requireBranch(req)}::uuid AND s.money_event_version=0
      AND ((${isOwn} AND p.cash_register_session_id=${cashRegisterSessionId}::uuid) OR
        (${!isOwn} AND p.paid_at>=${start} AND p.paid_at<=${end}))` : []
    const supplierTotals = applyReturnSettlements(paymentMethodsMap, supplierPayments.map(payment => ({ ...payment, kind: 'REFUND', payment_method: { name: payment.method_name, settlement_kind: payment.settlement_kind } })))

    let theoreticalTotal = theoreticalSales - theoreticalReturns + theoreticalCollections - supplierTotals.refunds

    const cashDetail = await applyOpeningFloatToCashBreakdown(prisma,req.companyId,paymentMethodsMap, sessionOpeningFloat)
    if (cashDetail.openingFloat > 0) {
      theoreticalTotal += cashDetail.openingFloat
    }

    // Calcular métricas adicionales
    const totalTransactions = sales.length
    const totalCustomers = sales.filter(s => s.customer && s.customer !== 'Desconocido').length
    const averageTicket = totalTransactions > 0 ? theoreticalSales / totalTransactions : 0

    // Convertir Map a Array
    const paymentBreakdown = Array.from(paymentMethodsMap.values()).map(method => ({
      payment_method_id: method.id,
      payment_method_name: method.name,
      settlement_kind:method.settlement_kind??null,
      theoretical_amount: Number(method.theoretical_amount.toFixed(2)),
      theoretical_count: method.theoretical_count,
      sales_detail: method.sales
    }))

    let result = {
      calculation_basis: 'LEGACY', calculation_basis_label: 'Cálculo de compatibilidad histórica; no reconstruye movimientos ni consolida turnos por fecha operativa.',
      period: {
        start: start.toISOString(),
        end: end.toISOString()
      },
      theoretical: {
        total_sales: Number(theoreticalSales.toFixed(2)),
        total_returns: Number(theoreticalReturns.toFixed(2)),
        total_collections: Number(theoreticalCollections.toFixed(2)),
        total_supplier_payments: supplierTotals.refunds,
        net_total: Number(theoreticalTotal.toFixed(2))
      },
      collections: collections.map(c => ({
        id: c.id,
        customer: c.customer?.name || null,
        amount: number(c.amount),
        payment_method: c.payment_method?.name || null,
        paid_at: c.paid_at,
        reference: c.reference
      })),
      unidentified_collections_amount: Number(unidentifiedCollections.toFixed(2)),
      return_settlements: returnSettlements.map((settlement) => ({
        id: settlement.id,
        return_reference: settlement.return?.reference || null,
        sale_reference: settlement.return?.sale?.reference || null,
        kind: settlement.kind,
        amount: number(settlement.amount),
        payment_method: settlement.payment_method?.name || null,
        created_at: settlement.created_at,
      })),
      advance_refunds:advanceRefunds.map(refund=>({id:refund.id,engagement_id:refund.engagement_id,payment_id:refund.payment_id,amount:number(refund.amount),payment_method:refund.payment_method?.name||null,confirmed_at:refund.confirmed_at})),
      supplier_payments: supplierPayments.map(payment => ({ id: payment.id, amount: number(payment.amount), payment_method: payment.method_name, paid_at: payment.paid_at })),
      cash_session: cashDetail.openingFloat > 0
        ? {
            opening_float: Number(cashDetail.openingFloat.toFixed(2)),
            cash_sales_amount: Number(cashDetail.cashSalesAmount.toFixed(2)),
            expected_cash_in_drawer: Number(
              (cashDetail.cashSalesAmount + cashDetail.openingFloat).toFixed(2)
            )
          }
        : null,
      metrics: {
        total_transactions: totalTransactions,
        total_customers: totalCustomers,
        average_ticket: Number(averageTicket.toFixed(2))
      },
      payment_breakdown: paymentBreakdown
    }
    if (available && !isOwn) result = eventReader.mergeTheoretical(result, await eventReader.calculateEventTheoretical(prisma, { companyId: req.companyId, branchId: requireBranch(req) }, { start, end }))
    result.calculation_key = calculationKey(req, result)
    return result
}

module.exports = { calculateTheoreticalData }
