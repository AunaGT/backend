/**
 * Configuración de vigencia cotizaciones / pedidos (system_settings).
 */

const { prisma } = require('../models/prisma')

const DEFAULT_QUOTE_DAYS = 30
const DEFAULT_ORDER_DAYS = 7
const DEFAULT_QUOTE_SOFT_HOLD_HOURS = 48

function parsePositiveInt(raw, fallback) {
  const n = parseInt(String(raw ?? ''), 10)
  return Number.isFinite(n) && n >= 1 ? n : fallback
}

async function getCommercialDocSettings(client, companyId) {
  const db = client || prisma
  const rows = await db.systemSetting.findMany({
    where: {
      key: { in: ['quote_validity_days', 'order_validity_days', 'quote_soft_hold_hours'] },
      ...(companyId ? { company_id: companyId } : {}),
    },
  })
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]))
  return {
    quoteValidityDays: parsePositiveInt(map.quote_validity_days, DEFAULT_QUOTE_DAYS),
    orderValidityDays: parsePositiveInt(map.order_validity_days, DEFAULT_ORDER_DAYS),
    quoteSoftHoldHours: parsePositiveInt(map.quote_soft_hold_hours, DEFAULT_QUOTE_SOFT_HOLD_HOURS),
  }
}

function addDays(days) {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return d
}

async function defaultQuoteValidUntil(client, companyId) {
  const { quoteValidityDays } = await getCommercialDocSettings(client, companyId)
  return addDays(quoteValidityDays)
}

async function defaultOrderValidUntil(client) {
  const { orderValidityDays } = await getCommercialDocSettings(client)
  return addDays(orderValidityDays)
}

function addHours(hours) {
  return new Date(Date.now() + hours * 60 * 60 * 1000)
}

async function defaultQuoteSoftHoldExpiresAt(client, companyId) {
  const { quoteSoftHoldHours } = await getCommercialDocSettings(client, companyId)
  return addHours(quoteSoftHoldHours)
}

module.exports = {
  DEFAULT_QUOTE_DAYS,
  DEFAULT_ORDER_DAYS,
  DEFAULT_QUOTE_SOFT_HOLD_HOURS,
  getCommercialDocSettings,
  defaultQuoteValidUntil,
  defaultOrderValidUntil,
  defaultQuoteSoftHoldExpiresAt,
}
