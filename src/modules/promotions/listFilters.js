const { parsePromotionDate } = require('./validation')

function buildPromotionListWhere(query = {}, companyId, branchFilter = {}, now = new Date()) {
  const where = { deleted: false, company_id: companyId, ...branchFilter }
  const conditions = []
  const search = String(query.search || '').trim().slice(0, 100)
  if (search) conditions.push({ OR: [
    { name: { contains: search, mode: 'insensitive' } },
    { description: { contains: search, mode: 'insensitive' } },
    { codes: { some: { code: { contains: search, mode: 'insensitive' } } } },
  ] })
  if (query.active !== undefined) conditions.push({ active: query.active === 'true' })
  if (query.type_id && Number.isInteger(Number(query.type_id))) conditions.push({ type_id: Number(query.type_id) })
  if (query.scope === 'global') conditions.push({ applies_to_all_branches: true })
  if (query.scope === 'specific') conditions.push({ applies_to_all_branches: false })
  const from = /^\d{4}-\d{2}-\d{2}$/.test(query.date_from || '') ? parsePromotionDate(query.date_from) : null
  const to = /^\d{4}-\d{2}-\d{2}$/.test(query.date_to || '') ? parsePromotionDate(query.date_to, true) : null
  if ((from && !Number.isNaN(from.getTime())) || (to && !Number.isNaN(to.getTime()))) {
    const dates = {}
    if (from && !Number.isNaN(from.getTime())) dates.gte = from
    if (to && !Number.isNaN(to.getTime())) dates.lt = new Date(to.getTime() + 1)
    conditions.push({ start_date: dates })
  }
  switch (query.status) {
    case 'inactive': conditions.push({ active: false }); break
    case 'scheduled': conditions.push({ active: true, start_date: { gt: now } }); break
    case 'ended': conditions.push({ active: true, end_date: { lte: now } }); break
    case 'active': conditions.push({ active: true, start_date: { lte: now }, OR: [{ end_date: null }, { end_date: { gt: now } }] }); break
  }
  if (conditions.length) where.AND = conditions
  return where
}

function attachPromotionUsage(items, groupedUsage) {
  const byId = new Map(groupedUsage.map((entry) => [entry.promotion_id, entry]))
  return items.map((item) => {
    const usage = byId.get(item.id)
    return { ...item, usage: {
      used: usage?._sum?.current_uses ?? 0,
      capacity: item.max_uses ? item.max_uses * (usage?._count?.id ?? 0) : null,
    } }
  })
}

module.exports = { buildPromotionListWhere, attachPromotionUsage }
