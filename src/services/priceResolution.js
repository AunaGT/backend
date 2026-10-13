/**
 * Copyright (c) 2026 Diego Patzán. All Rights Reserved.
 *
 * Resolución de precio unitario según tarifa (lista / mayoreo / promoción) y reglas por cliente/canal.
 */

const VALID_CHANNELS = new Set(['POS', 'WHOLESALE', 'ONLINE'])
const VALID_PRICE_TIERS = new Set(['LIST', 'WHOLESALE', 'PROMOTION'])

function parsePriceTier(raw) {
  const t = raw != null ? String(raw).toUpperCase() : ''
  return VALID_PRICE_TIERS.has(t) ? t : null
}

function numberOrZero(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/**
 * @param {{ price: unknown, price_wholesale?: unknown|null, price_promotion?: unknown|null, promotion_valid_until?: Date|null }} product
 * @param {'LIST'|'WHOLESALE'|'PROMOTION'} tier
 * @param {Date} [now]
 * @returns {number}
 */
function resolveUnitPriceFromProduct(product, tier, now = new Date()) {
  const list = numberOrZero(product.price)
  const wholesale =
    product.price_wholesale != null && product.price_wholesale !== ''
      ? numberOrZero(product.price_wholesale)
      : null
  const promoRaw =
    product.price_promotion != null && product.price_promotion !== ''
      ? numberOrZero(product.price_promotion)
      : null
  const promoUntil = product.promotion_valid_until

  if (tier === 'WHOLESALE' && wholesale != null && wholesale > 0) {
    return wholesale
  }
  if (tier === 'PROMOTION' && promoRaw != null && promoRaw > 0) {
    if (!promoUntil || new Date(promoUntil) >= now) {
      return promoRaw
    }
  }
  return list
}

function isPromotionActive(product, now = new Date()) {
  const promoRaw =
    product.price_promotion != null && product.price_promotion !== ''
      ? numberOrZero(product.price_promotion)
      : null
  if (promoRaw == null || promoRaw <= 0) return false
  const promoUntil = product.promotion_valid_until
  if (!promoUntil) return true
  return new Date(promoUntil) >= now
}

function productSupportsPriceTier(product, tier, now = new Date()) {
  if (tier === 'LIST') return { ok: true }
  if (tier === 'WHOLESALE') {
    const wholesale =
      product.price_wholesale != null && product.price_wholesale !== ''
        ? numberOrZero(product.price_wholesale)
        : null
    if (wholesale != null && wholesale > 0) return { ok: true }
    return { ok: false, reason: 'sin precio de mayoreo' }
  }
  if (tier === 'PROMOTION') {
    if (isPromotionActive(product, now)) return { ok: true }
    const promoRaw =
      product.price_promotion != null && product.price_promotion !== ''
        ? numberOrZero(product.price_promotion)
        : null
    if (promoRaw == null || promoRaw <= 0) {
      return { ok: false, reason: 'sin precio promocional' }
    }
    return { ok: false, reason: 'promoción vencida o no vigente' }
  }
  return { ok: false, reason: 'tarifa no válida' }
}

/**
 * @param {import('@prisma/client').Prisma.TransactionClient|import('@prisma/client').PrismaClient} tx
 * @param {{ customerContactId?: string|null, salesChannel?: string|null }} ctx
 * @returns {Promise<'LIST'|'WHOLESALE'|'PROMOTION'>}
 */
async function resolvePriceTierForContext(tx, ctx) {
  const raw = ctx.salesChannel != null ? String(ctx.salesChannel).toUpperCase() : 'POS'
  const channel = VALID_CHANNELS.has(raw) ? raw : 'POS'
  const customerId = ctx.customerContactId != null ? String(ctx.customerContactId).trim() : ''

  if (customerId) {
    const customer = await tx.supplier.findFirst({
      where: { id: customerId, deleted: false, party_type: 'CUSTOMER',...(ctx.companyId ? {company_id:ctx.companyId} : {}) },
      select: {
        id: true,
        default_price_tier: true,
        customer_price_rules: {
          where: { active: true },
          orderBy: [{ priority: 'desc' }, { created_at: 'asc' }],
        },
      },
    })
    if (!customer && ctx.companyId) throw Object.assign(new Error('Cliente no encontrado en esta empresa'),{status:400})
    if (customer) {
      const rules = customer.customer_price_rules || []
      const applicable = rules.filter((r) => !r.channel || r.channel === channel)
      if (applicable.length > 0) {
        return applicable[0].price_tier
      }
      return customer.default_price_tier || 'LIST'
    }
  }

  if (channel === 'WHOLESALE') {
    return 'WHOLESALE'
  }
  return 'LIST'
}

module.exports = {
  resolveUnitPriceFromProduct,
  resolvePriceTierForContext,
  isPromotionActive,
  productSupportsPriceTier,
  parsePriceTier,
  VALID_CHANNELS,
  VALID_PRICE_TIERS,
}
