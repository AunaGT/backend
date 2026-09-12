/**
 * Vencimiento de cotizaciones/pedidos y reservas de stock.
 */

const { prisma } = require('../models/prisma')
const { releaseByDocument } = require('./stockAvailability')
const { readCompanyModules } = require('../modules/platform/service')

const QUOTE_EXPIRABLE = ['DRAFT', 'SENT', 'ACCEPTED']
const ORDER_EXPIRABLE = ['DRAFT', 'CONFIRMED', 'PARTIALLY_FULFILLED']

async function filterEnabledQuoteIds(
  overdueQuotes,
  client,
  loadModules = readCompanyModules
) {
  const enabledByCompany = new Map()
  const ids = []

  for (const quote of overdueQuotes) {
    const companyId = quote.branch.company_id
    if (!enabledByCompany.has(companyId)) {
      const modules = await loadModules(companyId, client, { useCache: false })
      enabledByCompany.set(
        companyId,
        Boolean(modules.find((module) => module.code === 'quotes')?.effectiveEnabled)
      )
    }
    if (enabledByCompany.get(companyId)) ids.push(quote.id)
  }

  return ids
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
      select: { id: true, status: true },
    })

    for (const order of overdueOrders) {
      if (order.status === 'CONFIRMED' || order.status === 'PARTIALLY_FULFILLED') {
        await releaseByDocument(tx, order.id, { status: 'EXPIRED' })
      }
    }
    if (overdueOrders.length) {
      const r = await tx.commercialDocument.updateMany({
        where: { id: { in: overdueOrders.map((d) => d.id) } },
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
  filterEnabledQuoteIds,
}
