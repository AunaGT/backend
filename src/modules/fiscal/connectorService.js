const { randomUUID, createHmac } = require('node:crypto')
const { Prisma } = require('@prisma/client')
const { authorize } = require('./permissions')
const { fail } = require('./errors')
const { contractFor } = require('./infile/contract')
const { normalizeEndpoints, endpointSettings } = require('./endpoints')
const { readKeyring, CREDENTIAL_FIELDS, validateCredentials, sealCredentials, openCredentials } = require('./credentials')
const { normalizeProfileDraft, buildLocalProfile, issuerFromSettings, profileIssues, EMITTER_KEYS, PROFILE_BYTES } = require('./profiles')
const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i
const versions = { orderBy: { number: 'desc' }, take: 1, include: { establishments: { orderBy: { branch_id: 'asc' } } } }

function parseCommand(raw, save = false) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(k => !['environment', 'expectedVersion', 'idempotencyKey', ...(save === true ? ['credentials', 'endpoints'] : save === 'profile' ? ['profile', 'expectedIssuerFingerprint'] : [])].includes(k))) throw fail(422, 'FISCAL_INPUT_INVALID', 'La solicitud contiene campos no permitidos')
  contractFor(raw.environment)
  if (!Number.isSafeInteger(raw.expectedVersion) || raw.expectedVersion < 0 || raw.expectedVersion > 2147483646 || !uuid.test(raw.idempotencyKey || '')) throw fail(422, 'FISCAL_INPUT_INVALID', 'Actualiza la conexión antes de guardar')
  const out = { environment: raw.environment, expectedVersion: raw.expectedVersion, idempotencyKey: raw.idempotencyKey.toLowerCase() }
  if (save === true && raw.endpoints !== undefined) out.endpoints = normalizeEndpoints(raw.endpoints)
  if (save === true && raw.credentials !== undefined) {
    if (!raw.credentials || typeof raw.credentials !== 'object' || Array.isArray(raw.credentials) || !Object.keys(raw.credentials).length || Object.keys(raw.credentials).some(k => !CREDENTIAL_FIELDS.includes(k))) throw fail(422, 'FISCAL_CREDENTIALS_INVALID', 'Envía solo los campos de conexión que deseas reemplazar')
    // Validate provided values without turning omitted fields into blank replacements.
    const checked = validateCredentials(Object.fromEntries(CREDENTIAL_FIELDS.map(k => [k, Object.hasOwn(raw.credentials, k) ? raw.credentials[k] : 'not-replaced'])))
    out.credentials = Object.fromEntries(CREDENTIAL_FIELDS.filter(k => Object.hasOwn(raw.credentials, k)).map(k => [k, checked[k]]))
  }
  if (save === 'profile') {
    if (typeof raw.expectedIssuerFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(raw.expectedIssuerFingerprint)) throw fail(422, 'FISCAL_INPUT_INVALID', 'Recarga los datos del emisor antes de guardar')
    out.expectedIssuerFingerprint = raw.expectedIssuerFingerprint
    out.profile = normalizeProfileDraft(raw.profile)
  }
  return out
}
function keyProvider(options) { return options?.keyring || readKeyring }
function keyReady(options) { try { keyProvider(options)(); return true } catch { return false } }
function dto(row, environment, options) {
  const configured = !!row?.versions?.[0]?.credentials, encryptionReady = keyReady(options)
  return {
    id: row?.id || null, provider: 'INFILE', environment, state: row?.state || 'DRAFT', revision: row?.revision || 0,
    updatedAt: row?.updated_at?.toISOString?.() || row?.updated_at || null,
    credentialStatus: Object.fromEntries(CREDENTIAL_FIELDS.map(k => [k, configured])),
    endpoints: endpointSettings(row?.versions?.[0]?.endpoints),
    capabilities: { externalSendingAllowed: false, productionReady: false, encryptionReady },
    blockingReasons: [...(!encryptionReady ? ['FISCAL_KEYRING_UNAVAILABLE'] : []), ...(!configured ? ['FISCAL_CREDENTIALS_MISSING'] : []), 'FISCAL_EXTERNAL_DISABLED', 'FISCAL_CONTRACT_UNCONFIRMED'],
    lastTestAt: null,
  }
}
function findConnection(db, scope, environment) {
  return db.fiscalConnector.findFirst({ where: { company_id: scope.companyId, provider: 'INFILE', environment }, include: { versions } })
}
async function readInfileConnection(db, scope, environment, options) {
  const s = authorize(scope); contractFor(environment)
  return dto(await findConnection(db, s, environment), environment, options)
}
function digest(scope, action, input, keyring, keyId) {
  const key = keyring.keys.get(keyId)
  if (!key) throw fail(503, 'FISCAL_KEYRING_UNAVAILABLE', 'Falta una clave de cifrado necesaria para recuperar este intento')
  return createHmac('sha256', key).update(JSON.stringify(['fiscal-command-v1', scope.companyId, scope.actorId, action, input])).digest('hex')
}
async function command(db, scope, action, input, options, run) {
  const keyring = keyProvider(options)()
  return db.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`fiscal-command:${scope.companyId}:${scope.actorId}:${action}:${input.idempotencyKey}`},0))`
    const old = await tx.fiscalEvent.findUnique({ where: { company_id_actor_id_action_request_key: { company_id: scope.companyId, actor_id: scope.actorId, action, request_key: input.idempotencyKey } } })
    if (old) {
      if (old.input_hash !== digest(scope, action, input, keyring, old.hash_key_id)) throw fail(409, 'FISCAL_IDEMPOTENCY_CONFLICT', 'Este intento ya se utilizó con otros datos')
      return old.result
    }
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`fiscal-connection:${scope.companyId}:${input.environment}`},0))`
    const row = await findConnection(tx, scope, input.environment)
    if ((row?.revision || 0) !== input.expectedVersion) throw fail(409, 'FISCAL_STALE_VERSION', 'La conexión cambió. Recarga antes de guardar; tus campos no se han enviado a Infile')
    const { result, connectorId } = await run(tx, row, keyring)
    await tx.fiscalEvent.create({ data: { company_id: scope.companyId, connector_id: connectorId, environment: input.environment, actor_id: scope.actorId, action, request_key: input.idempotencyKey, input_hash: digest(scope, action, input, keyring, keyring.activeKeyId), hash_key_id: keyring.activeKeyId, result } })
    return result
  }, { timeout: 15000, maxWait: 10000 })
}
async function saveInfileConnection(db, scope, raw, options) {
  const s = authorize(scope, 'manage'), input = parseCommand(raw, true)
  return command(db, s, 'SAVE_CONNECTION', input, options, async (tx, old, keyring) => {
    const previous = old?.versions?.[0]
    if (!previous && !input.credentials && !Object.values(input.endpoints || {}).some(Boolean)) throw fail(422, 'FISCAL_INPUT_INVALID', 'Indica credenciales o al menos una URL antes de crear la conexión')
    if (!input.credentials && !input.endpoints && previous) return { connectorId: old.id, result: dto(old, input.environment, options) }
    const { row, version } = await appendVersion(tx, s, old, input.environment, keyring, { credentials: input.credentials, endpoints: input.endpoints })
    return { connectorId: row.id, result: dto({ ...row, versions: [version] }, input.environment, options) }
  })
}
async function validateConnectionLocally(db, scope, raw, options) {
  const s = authorize(scope, 'test'), input = parseCommand(raw)
  return command(db, s, 'VALIDATE_LOCAL', input, options, async (_tx, row) => {
    if (!row) throw fail(409, 'FISCAL_CONNECTION_REQUIRED', 'Guarda la conexión antes de revisarla')
    return { connectorId: row.id, result: { kind: 'LOCAL_ONLY', environment: input.environment, revision: row.revision, externalContact: false, credentialsConfigured: !!row.versions[0]?.credentials, credentialsVerified: false, productionReady: false, blockingReasons: dto(row, input.environment, options).blockingReasons } }
  })
}
async function connectionHistory(db, scope, environment) {
  const s = authorize(scope); contractFor(environment)
  const rows = await db.fiscalEvent.findMany({ where: { company_id: s.companyId, environment }, orderBy: [{ created_at: 'desc' }, { id: 'desc' }], take: 25, select: { id: true, action: true, actor_id: true, created_at: true } })
  return rows.map(row => ({ id: row.id, action: row.action, actorId: row.actor_id, createdAt: row.created_at.toISOString() }))
}
function versionProfile(version) {
  return version?.profile ? { ...version.profile, establishments: (version.establishments || []).map(row => row.data) } : null
}
async function appendVersion(tx, scope, old, environment, keyring, changes) {
  const previous = old?.versions?.[0], connectorId = old?.id || randomUUID(), number = (old?.revision || 0) + 1
  const context = { companyId: scope.companyId, connectorId, environment, credentialVersion: number }
  const saved = previous?.credentials ? openCredentials({ ...context, credentialVersion: previous.number }, previous.credentials, keyring) : null
  const credentials = saved || changes.credentials ? sealCredentials(context, { ...saved, ...changes.credentials }, keyring) : Prisma.DbNull
  const fullProfile = changes.profile ?? versionProfile(previous)
  const { establishments = [], ...profile } = fullProfile || {}
  const row = old ? await tx.fiscalConnector.update({ where: { id: old.id }, data: { revision: { increment: 1 }, state: 'DRAFT' } }) : await tx.fiscalConnector.create({ data: { id: connectorId, company_id: scope.companyId, environment, provider: 'INFILE' } })
  const endpoints = Object.fromEntries(Object.entries({ ...previous?.endpoints, ...changes.endpoints }).filter(([, value]) => value !== null))
  const version = await tx.fiscalConnectorVersion.create({ data: { company_id: scope.companyId, connector_id: connectorId, environment, number, credentials, endpoints, profile: fullProfile ? profile : Prisma.DbNull, created_by: scope.actorId } })
  if (establishments.length) await tx.fiscalEstablishment.createMany({ data: establishments.map(data => ({ company_id: scope.companyId, connector_version_id: version.id, environment, branch_id: data.branchId, data })) })
  return { row, version }
}
const catalogKinds = {
  branch: { model: 'branch', filter: { active: true }, labelKind: 'BRANCH' },
  category: { model: 'productCategory', filter: { deleted: false }, labelKind: 'CATEGORY' },
  product: { model: 'product', filter: { deleted: false }, labelKind: 'LEGACY_PRODUCT' },
  unit: { model: 'measureUnit', filter: { active: true }, labelKind: 'UNIT' },
  presentation: { model: 'productPresentation', filter: { active: true }, labelKind: 'PRESENTATION' },
}
async function referencedCatalog(db, scope, draft, strict = false) {
  const ids = {
    branch: draft.establishments.map(row => row.branchId), category: draft.categoryTaxMap.map(row => row.categoryId),
    product: [...draft.productTaxMap.map(row => row.productId), ...draft.unitMap.filter(row => row.kind === 'LEGACY_PRODUCT').map(row => row.targetId)],
    unit: draft.unitMap.filter(row => row.kind === 'UNIT').map(row => row.targetId), presentation: draft.unitMap.filter(row => row.kind === 'PRESENTATION').map(row => row.targetId),
  }
  const labels = {}, fieldErrors = {}
  for (const [kind, values] of Object.entries(ids)) {
    if (!values.length) continue
    const definition = catalogKinds[kind], unique = [...new Set(values)]
    const rows = await db[definition.model].findMany({ where: { company_id: scope.companyId, id: { in: unique }, ...definition.filter }, select: { id: true, name: true } })
    rows.forEach(row => { labels[`${definition.labelKind}:${row.id}`] = row.name })
    if (rows.length !== unique.length) fieldErrors[`references.${kind}`] = 'Revisa los destinos: deben pertenecer a esta empresa y seguir disponibles.'
  }
  if (strict && Object.keys(fieldErrors).length) throw fail(422, 'FISCAL_PROFILE_REFERENCE_INVALID', 'Hay mapeos que no están disponibles en esta empresa', fieldErrors)
  return { labels, fieldErrors }
}
async function saveFiscalProfile(db, scope, raw, options) {
  const s = authorize(scope, 'manage'), input = parseCommand(raw, 'profile')
  return command(db, s, 'SAVE_PROFILE', input, options, async (tx, old, keyring) => {
    await referencedCatalog(tx, s, input.profile, true)
    const settings = await tx.systemSetting.findMany({ where: { company_id: s.companyId, key: { in: EMITTER_KEYS } }, select: { key: true, value: true, revision: true } })
    if (issuerFromSettings(settings).settingsFingerprint !== input.expectedIssuerFingerprint) throw fail(409, 'FISCAL_ISSUER_CHANGED', 'Los datos fiscales o las tasas de Contabilidad cambiaron. Recarga y revísalos antes de guardar el perfil.')
    const profile = buildLocalProfile(input.profile, settings)
    if (Buffer.byteLength(JSON.stringify(profile)) > PROFILE_BYTES) throw fail(413, 'FISCAL_PROFILE_TOO_LARGE', 'El perfil completo supera 128 KiB')
    const { row, version } = await appendVersion(tx, s, old, input.environment, keyring, { profile })
    return { connectorId: row.id, result: { id: row.id, revision: row.revision, versionId: version.id, localOnly: true, productionReady: false } }
  })
}
async function readFiscalProfile(db, scope, environment) {
  const s = authorize(scope); contractFor(environment)
  const row = await findConnection(db, s, environment), version = row?.versions?.[0], profile = versionProfile(version)
  const settings = await db.systemSetting.findMany({ where: { company_id: s.companyId, key: { in: EMITTER_KEYS } }, select: { key: true, value: true, revision: true } })
  const currentIssuer = issuerFromSettings(settings), fieldErrors = profileIssues(profile)
  const references = profile ? await referencedCatalog(db, s, profile) : { labels: {}, fieldErrors: {} }
  Object.assign(fieldErrors, references.fieldErrors)
  if (profile && profile.settingsFingerprint !== currentIssuer.settingsFingerprint) fieldErrors['emitter.changed'] = 'Los datos fiscales o las tasas de Contabilidad cambiaron. Revisa y vuelve a guardar este perfil.'
  if (profile?.taxRules?.some(rule => rule.mode === 'EXEMPT')) fieldErrors['taxConfiguration.accountingAlignment'] = 'Las exenciones por producto o categoría son preparación local: todavía no modifican los asientos contables. Falta integrar el cálculo por línea antes de habilitar este perfil.'
  return { connectionId: row?.id || null, revision: row?.revision || 0, versionId: version?.id || null, environment, profile, currentIssuer, labels: references.labels, readiness: { valid: !!profile && !Object.keys(fieldErrors).length, productionReady: false, externalContact: false, fieldErrors } }
}
async function profileOptions(db, scope, query) {
  const s = authorize(scope), kind = query?.kind, definition = catalogKinds[kind]
  if (!Object.hasOwn(catalogKinds, kind || '') || typeof query.query !== 'string' || query.query.length > 100 || !/^[1-9]\d{0,3}$/.test(String(query.page || '1'))) throw fail(422, 'FISCAL_INPUT_INVALID', 'Revisa la búsqueda del catálogo')
  const page = Number(query.page || '1'), pageSize = 25, where = { company_id: s.companyId, ...definition.filter, ...(query.query.trim() ? { name: { contains: query.query.trim(), mode: 'insensitive' } } : {}) }
  const [rows, total] = await Promise.all([db[definition.model].findMany({ where, select: { id: true, name: true }, orderBy: [{ name: 'asc' }, { id: 'asc' }], skip: (page - 1) * pageSize, take: pageSize }), db[definition.model].count({ where })])
  return { rows: rows.map(row => ({ id: row.id, label: row.name })), total, page, pageSize }
}
module.exports = { readInfileConnection, saveInfileConnection, validateConnectionLocally, connectionHistory, saveFiscalProfile, readFiscalProfile, profileOptions }
