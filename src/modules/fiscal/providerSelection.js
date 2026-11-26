const { authorize } = require('./permissions')
const { fail } = require('./errors')
const { writeSettings } = require('../../services/settingsRevision')
const KEY = 'fiscal.selected_provider'
const providers = [{ id: 'INFILE', name: 'Infile', mode: 'OFFLINE', externalSendingAllowed: false }]
const stale = () => fail(409, 'FISCAL_PROVIDER_STALE', 'La selección cambió en otra sesión. Recarga antes de continuar.')

async function readSlot(db, companyId) {
  const row = await db.systemSetting.findUnique({ where: { company_id_key: { company_id: companyId, key: KEY } }, select: { value: true, revision: true, type: true } })
  if (row && row.value !== '' && !/^[A-Z][A-Z0-9_]{0,29}$/.test(row.value)) throw fail(503, 'FISCAL_PROVIDER_INVALID', 'La selección guardada necesita revisión del administrador.')
  return row
}
const catalog = row => ({ selectedProvider: row?.value || null, revision: row?.revision || 0, providers, externalSendingAllowed: false })

async function readProviderCatalog(db, scope) {
  const s = authorize(scope)
  return catalog(await readSlot(db, s.companyId))
}
async function selectProvider(db, scope, raw) {
  const s = authorize(scope, 'manage')
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !['provider', 'expectedRevision'].includes(key)) || !Object.hasOwn(raw, 'provider') || raw.provider !== null && !providers.some(p => p.id === raw.provider) || !Number.isSafeInteger(raw.expectedRevision) || raw.expectedRevision < 0 || raw.expectedRevision >= 2147483647) throw fail(422, 'FISCAL_PROVIDER_INPUT_INVALID', 'Selecciona un conector disponible y recarga su revisión antes de guardar.')
  return db.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`fiscal-provider:${s.companyId}`},0))`
    const previous = await readSlot(tx, s.companyId), current = previous?.value || null
    if ((previous?.revision || 0) !== raw.expectedRevision) throw stale()
    if (current && raw.provider && current !== raw.provider) throw fail(409, 'FISCAL_PROVIDER_ALREADY_SELECTED', 'Primero desactiva el conector actual para activar otro.')
    if (current === raw.provider) return catalog(previous)
    let rows
    try { rows = await writeSettings(tx, { companyId: s.companyId, changes: { [KEY]: { value: raw.provider || '', type: 'string' } }, expectedRevisions: { [KEY]: raw.expectedRevision } }) }
    catch (error) { if (error.status === 409) throw stale(); throw error }
    const saved = rows[0]
    // The generic audit trigger deliberately ignores private connector keys.
    await tx.settingAuditEvent.create({ data: { company_id: s.companyId, key: KEY, before_value: previous?.value ?? null, after_value: saved.value, before_type: previous?.type ?? null, after_type: saved.type, before_revision: previous?.revision ?? null, revision: saved.revision, actor_id: s.actorId, source: 'fiscal-provider-selection' } })
    return catalog(saved)
  }, { timeout: 15000, maxWait: 10000 })
}
module.exports = { readProviderCatalog, selectProvider }
