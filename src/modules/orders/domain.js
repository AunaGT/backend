const ORDER_STATUSES = ['DRAFT', 'CONFIRMED', 'PARTIALLY_FULFILLED', 'FULFILLED', 'CANCELLED', 'EXPIRED']

const PREPARATION_STATUSES = {
  pending: ['DRAFT'],
  preparing: ['CONFIRMED'],
  ready: ['PARTIALLY_FULFILLED', 'FULFILLED'],
  delayed: ['EXPIRED'],
  cancelled: ['CANCELLED'],
}

const DELIVERY_STATUSES = {
  pending: ['DRAFT', 'CONFIRMED', 'EXPIRED'],
  transit: ['PARTIALLY_FULFILLED'],
  delivered: ['FULFILLED'],
  cancelled: ['CANCELLED'],
}

const intersect = (left, right) => left.filter((status) => right.includes(status))

function resolveOrderStatuses({ status, preparation, delivery } = {}) {
  let selected
  if (status && String(status).toUpperCase() !== 'ALL') {
    const normalized = String(status).toUpperCase()
    if (!ORDER_STATUSES.includes(normalized)) throw Object.assign(new Error('Estado de pedido inválido'), { status: 400 })
    selected = [normalized]
  }
  if (preparation && preparation !== 'all') {
    const values = PREPARATION_STATUSES[preparation]
    if (!values) throw Object.assign(new Error('Estado de preparación inválido'), { status: 400 })
    selected = selected ? intersect(selected, values) : values
  }
  if (delivery && delivery !== 'all') {
    const values = DELIVERY_STATUSES[delivery]
    if (!values) throw Object.assign(new Error('Estado de entrega inválido'), { status: 400 })
    selected = selected ? intersect(selected, values) : values
  }
  return selected
}

function parseDate(value, label) {
  if (!value) return null
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw Object.assign(new Error(`${label} inválida`), { status: 400 })
  const date = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw Object.assign(new Error(`${label} inválida`), { status: 400 })
  }
  return date
}

function buildOrderDateFilter(from, to) {
  const gte = parseDate(from, 'Fecha desde')
  const end = parseDate(to, 'Fecha hasta')
  if (!gte && !end) return undefined
  const filter = {}
  if (gte) filter.gte = gte
  if (end) {
    const lt = new Date(end)
    lt.setUTCDate(lt.getUTCDate() + 1)
    filter.lt = lt
  }
  return filter
}

function resolveOrderOrderBy(sort = 'created_desc') {
  const options = {
    created_desc: { created_at: 'desc' },
    created_asc: { created_at: 'asc' },
    total_desc: { total: 'desc' },
    total_asc: { total: 'asc' },
  }
  if (!options[sort]) throw Object.assign(new Error('Orden inválido'), { status: 400 })
  return options[sort]
}

module.exports = { buildOrderDateFilter, resolveOrderOrderBy, resolveOrderStatuses }
