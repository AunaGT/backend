function normalizeTaxId(raw) {
  if (raw === undefined) return undefined
  if (raw === null || raw === '') return null
  const s = String(raw).trim()
  return s.length ? s : null
}

/** @returns {'PERSON'|'ORGANIZATION'} */
function normalizeEntityKind(raw) {
  if (raw === undefined || raw === null || raw === '') return 'ORGANIZATION'
  const s = String(raw).toUpperCase().trim()
  if (s === 'PERSON' || s === 'INDIVIDUAL' || s === 'NATURAL') return 'PERSON'
  if (s === 'ORGANIZATION' || s === 'ORG' || s === 'COMPANY' || s === 'EMPRESA') return 'ORGANIZATION'
  return 'ORGANIZATION'
}

/**
 * @param {{ entityKind: 'PERSON'|'ORGANIZATION', name: string, contact?: string|null }} p
 * @returns {{ ok: true, name: string, contact: string } | { ok: false, message: string }}
 */
function resolveContactForEntityKind(p) {
  const name = String(p.name || '').trim()
  let contact = p.contact != null ? String(p.contact).trim() : ''
  if (p.entityKind === 'PERSON') {
    if (!name) return { ok: false, message: 'El nombre es requerido' }
    if (!contact) contact = name
    return { ok: true, name, contact }
  }
  if (!name) return { ok: false, message: 'El nombre o razón social es requerido' }
  if (!contact) return { ok: false, message: 'La persona de contacto es requerida para una empresa' }
  return { ok: true, name, contact }
}


module.exports={normalizeTaxId,normalizeEntityKind,resolveContactForEntityKind}
