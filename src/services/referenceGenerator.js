/**
 * Referencias legibles POR SUCURSAL: V-SUC1-000001, P-SUC1-000001, T-SUC1-000001 (base62).
 * Las referencias viejas sin sucursal (V-000001) siguen siendo válidas para búsqueda.
 */

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

function toBase62(n) {
  if (n <= 0) return '0'
  let s = ''
  let num = n
  while (num > 0) {
    s = BASE62[num % 62] + s
    num = Math.floor(num / 62)
  }
  return s
}

function fromBase62(s) {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const idx = BASE62.indexOf(s[i])
    if (idx === -1) return NaN
    n = n * 62 + idx
  }
  return n
}

// Offset por prefijo dentro del rango de lock de cada sucursal
const REF_LOCK_OFFSETS = { V: 1, Q: 2, P: 3, T: 4, D: 5 }

/**
 * Genera la siguiente referencia del prefijo EN LA SUCURSAL dada.
 * El advisory lock se deriva de branch.seq, así cada sucursal numera sin
 * bloquear a las demás: 910000 + seq*10 + offset(prefijo).
 *
 * @param {import('@prisma/client').Prisma.TransactionClient} tx
 * @param {'V'|'Q'|'P'|'T'|'D'} prefix
 * @param {{ id: string, code: string, seq: number }} branch
 */
async function nextDocumentReference(tx, prefix, branch) {
  if (!branch || !branch.id || !branch.code || !Number.isFinite(Number(branch.seq))) {
    const err = new Error('nextDocumentReference requiere la sucursal (id, code, seq)')
    err.status = 500
    throw err
  }
  const offset = REF_LOCK_OFFSETS[prefix]
  const lockKey = 910000 + Number(branch.seq) * 10 + (offset || 0)
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockKey})`

  const refPrefix = `${prefix}-${branch.code}-`
  const pattern = new RegExp(`^${prefix}-${branch.code}-([0-9A-Za-z]+)$`)
  const formatRef = (num) => `${refPrefix}${toBase62(num).padStart(6, '0')}`

  const findLast = async (where) => {
    if (prefix === 'V') {
      const last = await tx.sale.findFirst({ where, orderBy: { reference: 'desc' }, select: { reference: true } })
      return last?.reference || null
    }
    if (prefix === 'T') {
      const last = await tx.stockTransfer.findFirst({ where, orderBy: { reference: 'desc' }, select: { reference: true } })
      return last?.reference || null
    }
    if (prefix === 'D') {
      const last = await tx.return.findFirst({ where, orderBy: { reference: 'desc' }, select: { reference: true } })
      return last?.reference || null
    }
    const last = await tx.commercialDocument.findFirst({ where, orderBy: { reference: 'desc' }, select: { reference: true } })
    return last?.reference || null
  }

  const referenceExists = async (reference) => {
    if (prefix === 'V') {
      return Boolean(await tx.sale.findFirst({
        where: { branch_id: branch.id, reference },
        select: { id: true },
      }))
    }
    if (prefix === 'T') {
      return Boolean(await tx.stockTransfer.findFirst({
        where: { from_branch_id: branch.id, reference },
        select: { id: true },
      }))
    }
    if (prefix === 'D') {
      return Boolean(await tx.return.findFirst({
        where: { sale: { branch_id: branch.id }, reference },
        select: { id: true },
      }))
    }
    return Boolean(await tx.commercialDocument.findFirst({
      where: { branch_id: branch.id, reference },
      select: { id: true },
    }))
  }

  const branchScope = prefix === 'T'
    ? { from_branch_id: branch.id }
    : prefix === 'D'
      ? { sale: { branch_id: branch.id } }
      : { branch_id: branch.id }
  const lastRef = await findLast({ ...branchScope, reference: { startsWith: refPrefix } })

  let nextNum = 1
  if (lastRef) {
    const match = String(lastRef).match(pattern)
    if (match) {
      const num = fromBase62(match[1])
      if (Number.isFinite(num) && num >= 0) {
        nextNum = num + 1
      }
    }
  }

  let candidate = formatRef(nextNum)
  while (await referenceExists(candidate)) {
    nextNum += 1
    candidate = formatRef(nextNum)
  }
  return candidate
}

module.exports = {
  toBase62,
  fromBase62,
  nextDocumentReference,
}
