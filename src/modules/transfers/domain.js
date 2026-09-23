const DIRECTIONS = new Set(['all', 'in', 'out'])
const STATUSES = new Set(['EN_TRANSITO', 'RECIBIDA', 'CANCELADA'])

function badRequest(message) {
  const error = new Error(message)
  error.status = 400
  return error
}

function buildTransferWhere({
  companyId,
  branchId,
  direction = 'all',
  status,
  search,
  fromBranchId,
  toBranchId,
}) {
  const normalizedDirection = String(direction || 'all').toLowerCase()
  if (!DIRECTIONS.has(normalizedDirection)) throw badRequest('Dirección de traslado inválida')

  const normalizedStatus = status ? String(status).toUpperCase() : null
  if (normalizedStatus && !STATUSES.has(normalizedStatus)) throw badRequest('Estado de traslado inválido')

  const filters = []
  if (branchId) {
    if (normalizedDirection === 'in') filters.push({ to_branch_id: branchId })
    else if (normalizedDirection === 'out') filters.push({ from_branch_id: branchId })
    else filters.push({ OR: [{ from_branch_id: branchId }, { to_branch_id: branchId }] })
  }
  if (fromBranchId) filters.push({ from_branch_id: String(fromBranchId) })
  if (toBranchId) filters.push({ to_branch_id: String(toBranchId) })
  if (normalizedStatus) filters.push({ status: normalizedStatus })

  const term = String(search || '').trim()
  if (term) {
    filters.push({ OR: [
      { reference: { contains: term, mode: 'insensitive' } },
      { fromBranch: { name: { contains: term, mode: 'insensitive' } } },
      { toBranch: { name: { contains: term, mode: 'insensitive' } } },
      { lines: { some: { product: { name: { contains: term, mode: 'insensitive' } } } } },
    ] })
  }

  filters.push({ fromBranch: { company_id: companyId } })
  return { AND: filters }
}

module.exports = { buildTransferWhere }
