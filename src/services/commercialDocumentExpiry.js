/**
 * Vencimiento de cotizaciones/pedidos y reservas de stock.
 */

const { prisma } = require('../models/prisma')
const { releaseByDocument } = require('./stockAvailability')
const { readCompanyModules } = require('../modules/platform/service')

const QUOTE_EXPIRABLE = ['DRAFT', 'SENT', 'ACCEPTED']
const ORDER_EXPIRABLE = ['DRAFT', 'CONFIRMED', 'PARTIALLY_FULFILLED']

async function filterEnabledDocumentIds(
  overdueDocuments,
  moduleCode,
  client,
  loadModules = readCompanyModules
) {
  const enabledByCompany = new Map()
  const ids = []

  for (const document of overdueDocuments) {
    const companyId = document.branch.company_id
    if (!enabledByCompany.has(companyId)) {
      const modules = await loadModules(companyId, client, { useCache: false })
      enabledByCompany.set(
        companyId,
        Boolean(modules.find((module) => module.code === moduleCode)?.effectiveEnabled)
      )
    }
    if (enabledByCompany.get(companyId)) ids.push(document.id)
  }

  return ids
}

function filterEnabledQuoteIds(overdueQuotes, client, loadModules = readCompanyModules) {
  return filterEnabledDocumentIds(overdueQuotes, 'quotes', client, loadModules)
}

function filterEnabledOrderIds(overdueOrders, client, loadModules = readCompanyModules) {
  return filterEnabledDocumentIds(overdueOrders, 'orders', client, loadModules)
}

async function expireCommercialDocuments(options = {}) {
  const now = options.now || new Date()
  const client = options.tx || prisma
  const summary = {
    quotesExpired: 0,
    ordersExpired: 0,
    reservationsExpired: 0,
    at: now.toISOString(),
  }

  const run = async (tx) => {
    const overdueQuotes = await tx.commercialDocument.findMany({
      where: {
        doc_type: 'QUOTE',
        status: { in: QUOTE_EXPIRABLE },
        valid_until: { lt: now },
      },
      select: {
        id: true,
        branch: { select: { company_id: true } },
      },
    })
    const enabledQuoteIds = await filterEnabledQuoteIds(overdueQuotes, tx)
    if (enabledQuoteIds.length) {
      for (const quoteId of enabledQuoteIds) {
        await releaseByDocument(tx, quoteId, { status: 'EXPIRED' })
      }
      const result = await tx.commercialDocument.updateMany({
        where: { id: { in: enabledQuoteIds } },
        data: { status: 'EXPIRED' },
      })
      summary.quotesExpired = result.count
    }

    const overdueOrders = await tx.commercialDocument.findMany({
      where: {
        doc_type: 'ORDER',
        status: { in: ORDER_EXPIRABLE },
        valid_until: { lt: now },
      },
      select: {
        id: true,
        status: true,
        branch: { select: { company_id: true } },
      },
    })

    const enabledOrderIds = await filterEnabledOrderIds(overdueOrders, tx)
    const enabledOrderIdSet = new Set(enabledOrderIds)

    for (const order of overdueOrders) {
      if (!enabledOrderIdSet.has(order.id)) continue
      if (order.status === 'CONFIRMED' || order.status === 'PARTIALLY_FULFILLED') {
        await releaseByDocument(tx, order.id, { status: 'EXPIRED' })
      }
    }
    if (enabledOrderIds.length) {
      const r = await tx.commercialDocument.updateMany({
        where: { id: { in: enabledOrderIds } },
        data: { status: 'EXPIRED' },
      })
      summary.ordersExpired = r.count
    }

    const res = await tx.stockReservation.updateMany({
      where: {
        status: 'ACTIVE',
        expires_at: { lt: now },
      },
      data: {
        status: 'EXPIRED',
        released_at: now,
      },
    })
    summary.reservationsExpired = res.count

    return summary
  }

  if (options.tx) return run(options.tx)
  return prisma.$transaction(run, { maxWait: 15_000, timeout: 60_000 })
}

module.exports = {
  expireCommercialDocuments,
  filterEnabledDocumentIds,
  filterEnabledOrderIds,
  filterEnabledQuoteIds,
}
