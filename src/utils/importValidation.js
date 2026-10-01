const normalizeName = value => String(value ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
const rowSet = (options, key) => new Set((Array.isArray(options?.[key]) ? options[key] : []).filter(Number.isSafeInteger))
const validMoney = value => Number.isFinite(value) && value >= 0 && value < 1e10 && Math.abs(value * 100 - Math.round(value * 100)) < 0.0001

function cell(row, aliases) {
  const entry = Object.entries(row).find(([key, value]) => aliases.includes(key.trim().toLowerCase()) && value !== '' && value != null)
  return entry?.[1] ?? ''
}

function nameCandidates(rows, aliases) {
  const prefixes = new Set()
  for (const row of rows) {
    const name = String(cell(row, aliases)).replace(/[\x00-\x1f\x7f]/g, '').trim().toLowerCase().slice(0, 150)
    for (const version of [name, normalizeName(name)]) {
      for (const word of version.split(/\s+/).filter(word => word.length >= 3)) {
        prefixes.add(word.slice(0, 3))
        prefixes.add(word.slice(-3))
      }
    }
  }
  return [...prefixes].map(prefix => ({ name: { contains: prefix, mode: 'insensitive' } }))
}

// Indexed fingerprints: accents, punctuation, word order and one-character typos.
// ponytail: not a semantic matcher; use a search index if multilingual synonym matching is needed.
function nameMatcher(records = []) {
  const index = new Map()
  const keys = name => {
    const normalized = normalizeName(name)
    if (!normalized) return []
    const compact = normalized.replace(/ /g, '')
    const values = [`words:${normalized.split(' ').sort().join(' ')}`, `typo:${compact}`]
    if (compact.length >= 5 && compact.length <= 150) {
      for (let i = 0; i < compact.length; i++) values.push(`typo:${compact.slice(0, i)}${compact.slice(i + 1)}`)
    }
    return values
  }
  function add(record) {
    for (const key of keys(record.name)) {
      if (!index.has(key)) index.set(key, [])
      const bucket = index.get(key)
      if (bucket.length < 5) bucket.push(record)
    }
  }
  records.forEach(add)
  return (name, rowIndex) => {
    const matches = new Map()
    const numbers = normalizeName(name).match(/\d+/g)?.join('|') || ''
    for (const key of keys(name)) {
      for (const record of index.get(key) || []) {
        if ((normalizeName(record.name).match(/\d+/g)?.join('|') || '') !== numbers) continue
        matches.set(record.rowIndex ?? record.id ?? record.name, record)
      }
    }
    add({ name, rowIndex })
    return [...matches.values()].slice(0, 3)
  }
}

function checkSimilarity(result, name, match, options, displayOffset = 0) {
  const matches = match(name, result.rowIndex)
  if (matches.length && !result.errors.length && !result.existingProductId && !rowSet(options, 'allowSimilarRowIndexes').has(result.rowIndex)) {
    result.similarMatches = matches.map(record => ({ name: record.name, rowIndex: record.rowIndex }))
    result.canCreateAnyway = true
    result.errors.push(`Posible duplicado por nombre: ${matches.map(record => `"${record.name}" (${record.rowIndex == null ? 'existente' : `fila ${record.rowIndex + displayOffset}`})`).join(', ')}. Revisa antes de crear igualmente.`)
    result.valid = false
  }
  return result
}

function checkText(row, limits, errors) {
  for (const [field, max] of Object.entries(limits)) {
    const value = row[field]
    if (value == null) continue
    if (String(value).length > max) errors.push(`${field}: máximo ${max} caracteres`)
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(String(value))) errors.push(`${field}: contiene caracteres de control no válidos`)
  }
}

module.exports = { normalizeName, rowSet, cell, nameCandidates, nameMatcher, checkSimilarity, checkText, validMoney }
