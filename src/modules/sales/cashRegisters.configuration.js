const { createHash, randomUUID } = require('node:crypto')
const { Prisma } = require('@prisma/client')
const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i
const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, code }) }
function parseRegisterConfiguration(raw) {
  const keys = ['requestKey','id','expectedRevision','name','code','currencyCode','authorizedUserIds','enableExplicitAccess','active','isDefault','operationMode']
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(k => !keys.includes(k))) fail(400, 'CASH_CONFIGURATION_INVALID', 'Datos de configuración no válidos')
  if (typeof raw.requestKey !== 'string' || !uuid.test(raw.requestKey)) fail(400, 'CASH_REQUEST_KEY', 'No se pudo identificar el intento de guardado')
  if (typeof raw.name !== 'string' || !raw.name.trim() || raw.name.trim().length > 120) fail(400, 'CASH_NAME_INVALID', 'Ingresa un nombre de hasta 120 caracteres')
  const input = { requestKey: raw.requestKey.toLowerCase(), name: raw.name.trim() }
  if (raw.operationMode !== undefined) {
    if (!['INDIVIDUAL', 'SHARED'].includes(raw.operationMode)) fail(400, 'CASH_MODE_INVALID', 'Selecciona Individual o Compartida')
    input.operationMode = raw.operationMode
  }
  if (raw.id !== undefined) {
    if (typeof raw.id !== 'string' || !uuid.test(raw.id)) fail(400, 'CASH_ID_INVALID', 'Caja no válida')
    input.id = raw.id.toLowerCase()
    if (raw.expectedRevision === undefined) fail(428, 'CASH_REVISION_REQUIRED', 'Carga la caja antes de guardar')
    if (!Number.isSafeInteger(raw.expectedRevision) || raw.expectedRevision < 1) fail(400, 'CASH_REVISION_INVALID', 'Revisión no válida')
    input.expectedRevision = raw.expectedRevision
    if (raw.code !== undefined) fail(400, 'CASH_CODE_IMMUTABLE', 'El código de una caja existente no se modifica')
  } else {
    if (typeof raw.code !== 'string' || !/^[A-Z\d][A-Z\d_-]{0,39}$/i.test(raw.code.trim())) fail(400, 'CASH_CODE_INVALID', 'Usa un código de hasta 40 letras, números, guiones o guiones bajos')
    if (raw.expectedRevision !== undefined) fail(400, 'CASH_REVISION_INVALID', 'Una caja nueva no tiene revisión anterior')
    input.code = raw.code.trim().toUpperCase()
  }
  for (const key of ['active', 'isDefault']) if (raw[key] !== undefined) {
    if (typeof raw[key] !== 'boolean') fail(400, 'CASH_BOOLEAN_INVALID', 'El estado debe ser verdadero o falso')
    input[key] = raw[key]
  }
  if (raw.currencyCode !== undefined) {
    if (typeof raw.currencyCode !== 'string' || !/^[A-Z]{3}$/.test(raw.currencyCode)) fail(400, 'CASH_CURRENCY_INVALID', 'Selecciona una moneda válida')
    input.currencyCode = raw.currencyCode
  }
  if (raw.authorizedUserIds !== undefined) {
    if (!Array.isArray(raw.authorizedUserIds) || raw.authorizedUserIds.length > 200 || raw.authorizedUserIds.some(id => typeof id !== 'string' || !uuid.test(id))) fail(400, 'CASH_USERS_INVALID', 'Selecciona hasta 200 personas válidas')
    input.authorizedUserIds = [...new Set(raw.authorizedUserIds.map(id => id.toLowerCase()))].sort()
  }
  if (raw.enableExplicitAccess !== undefined) {
    if (raw.enableExplicitAccess !== true) fail(400, 'CASH_ACCESS_VERSION', 'El control explícito no se desactiva ni se convierte automáticamente')
    input.enableExplicitAccess = true
  }
  return input
}
function registerConfigurationHash(input) {
  const { requestKey, ...content } = input
  return createHash('sha256').update(JSON.stringify(Object.keys(content).sort().map(key => [key, content[key]]))).digest('hex')
}
function requireScope(scope) {
  if (![scope?.companyId, scope?.branchId, scope?.userId].every(value => typeof value === 'string' && uuid.test(value))) fail(403, 'CASH_SCOPE_REQUIRED', 'Selecciona una empresa y sucursal válidas')
}
async function registerConfigurationAvailable(tx) {
  const [row] = await tx.$queryRaw`SELECT to_regclass('cash_register_access') IS NOT NULL AND to_regclass('cash_register_commands') IS NOT NULL
    AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('cash_registers') AND attname='access_control_version' AND NOT attisdropped) AS available`
  return row?.available === true
}
async function requireAvailable(tx) { if (!await registerConfigurationAvailable(tx)) fail(409, 'CASH_CONFIGURATION_UNAVAILABLE', 'La configuración avanzada todavía no está disponible. No se ha cambiado la caja.') }
async function registerRow(tx, scope, id, { lock = false } = {}) {
  if (!uuid.test(String(id))) fail(400, 'CASH_ID_INVALID', 'Caja no válida')
  const rows = await tx.$queryRaw(Prisma.sql`SELECT r.* FROM cash_registers r JOIN branches b ON b.id=r.branch_id
    WHERE r.id=${id}::uuid AND r.branch_id=${scope.branchId}::uuid AND b.company_id=${scope.companyId}::uuid ${lock ? Prisma.sql`FOR NO KEY UPDATE OF r` : Prisma.empty}`)
  if (!rows.length) fail(404, 'CASH_REGISTER_NOT_FOUND', 'Caja no encontrada en la sucursal activa')
  return rows[0]
}
async function loadRegisterConfiguration(tx, scope, id) {
  requireScope(scope); await requireAvailable(tx)
  const r = await registerRow(tx, scope, id)
  const users = await tx.$queryRaw`SELECT a.user_id AS id,u.name,(a.active AND uc.status='ACTIVE' AND ub.user_id IS NOT NULL) AS active
    FROM cash_register_access a JOIN users u ON u.id=a.user_id
    LEFT JOIN user_companies uc ON uc.user_id=a.user_id AND uc.company_id=a.company_id
    LEFT JOIN user_branches ub ON ub.user_id=a.user_id AND ub.branch_id=a.branch_id
    WHERE a.register_id=${id}::uuid AND a.company_id=${scope.companyId}::uuid AND a.branch_id=${scope.branchId}::uuid ORDER BY u.name,a.user_id`
  const legacy = await tx.user.findMany({ where: { cash_register_id: id }, select: { id: true, name: true }, orderBy: { name: 'asc' } })
  const [pending] = await tx.$queryRaw`SELECT EXISTS(SELECT 1 FROM cash_register_sessions WHERE cash_register_id=${id}::uuid AND status='OPEN') AS has_open_session,
    EXISTS(SELECT 1 FROM cash_register_sessions WHERE cash_register_id=${id}::uuid AND status='CLOSED' AND cash_closure_id IS NULL) AS has_pending_closure`
  return { id: r.id, name: r.name, code: r.code, branch_id: r.branch_id, active: r.active, is_default: r.is_default, kind: r.kind, operation_mode: r.operation_mode,
    currency_code: r.currency_code, money_event_version: r.money_event_version, revision: r.revision, access_control_version: r.access_control_version,
    authorized_users: users.map(u => ({ ...u, active: u.active === true })), legacy_suggested_users: legacy,
    ...pending, capabilities: { register_configuration_available: true, can_enable_explicit_access: r.active && r.money_event_version === 1 && r.access_control_version === 0 && r.kind === 'PHYSICAL' && r.operation_mode === 'INDIVIDUAL' && !!r.currency_code && !pending.has_open_session && users.some(u => u.active) } }
}
async function listEligibleRegisterUsers(tx, scope, { search = '', page = 1, pageSize = 20 } = {}) {
  requireScope(scope); await requireAvailable(tx)
  if (typeof search !== 'string' || search.length > 100 || !Number.isSafeInteger(Number(page)) || Number(page) < 1 || !Number.isSafeInteger(Number(pageSize)) || Number(pageSize) < 1 || Number(pageSize) > 50) fail(400, 'CASH_USER_FILTERS', 'Revisa la búsqueda y la página de personas')
  const where = { name: { contains: search.trim(), mode: 'insensitive' }, user_companies: { some: { company_id: scope.companyId, status: 'ACTIVE' } }, user_branches: { some: { branch_id: scope.branchId } } }
  const [items, totalItems] = await Promise.all([tx.user.findMany({ where, select: { id: true, name: true }, orderBy: [{ name: 'asc' }, { id: 'asc' }], skip: (Number(page) - 1) * Number(pageSize), take: Number(pageSize) }), tx.user.count({ where })])
  return { items, totalItems, page: Number(page), pageSize: Number(pageSize), totalPages: Math.max(1, Math.ceil(totalItems / Number(pageSize))) }
}
async function saveRegisterConfiguration(tx, scope, raw) {
  requireScope(scope); const input = parseRegisterConfiguration(raw), hash = registerConfigurationHash(input)
  await requireAvailable(tx)
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([scope.companyId,scope.branchId,scope.userId,input.requestKey])},0))::text AS locked`
  const [attempt] = await tx.$queryRaw`SELECT id,request_hash,result_snapshot FROM cash_register_commands
    WHERE company_id=${scope.companyId}::uuid AND branch_id=${scope.branchId}::uuid AND actor_id=${scope.userId}::uuid AND request_key=${input.requestKey}::uuid`
  if (attempt) {
    if (attempt.request_hash !== hash) fail(409, 'CASH_CONFIGURATION_ATTEMPT_CONFLICT', 'Ese intento pertenece a otra configuración; recupera primero su resultado')
    return { ...attempt.result_snapshot, command_id: attempt.id, replayed: true }
  }
  const branches = await tx.$queryRaw`SELECT id FROM branches WHERE id=${scope.branchId}::uuid AND company_id=${scope.companyId}::uuid FOR NO KEY UPDATE`
  if (!branches.length) fail(404, 'CASH_BRANCH_NOT_FOUND', 'Sucursal no encontrada')
  if (input.isDefault) await tx.$queryRaw`SELECT id FROM cash_registers WHERE branch_id=${scope.branchId}::uuid ORDER BY id FOR NO KEY UPDATE`
  let r = input.id ? await registerRow(tx, scope, input.id, { lock: true }) : null
  if (r && r.revision !== input.expectedRevision) fail(409, 'CASH_CONFIGURATION_STALE', 'La caja cambió. Carga el estado actual sin perder tu borrador.')
  const before = r ? await loadRegisterConfiguration(tx, scope, r.id) : null
  const mode = input.operationMode ?? r?.operation_mode ?? 'INDIVIDUAL'
  if (input.operationMode !== undefined && r && mode !== r.operation_mode && before.has_open_session) fail(409, 'CASH_MODE_OPEN', 'Termina el turno antes de cambiar la modalidad')
  if (mode === 'SHARED' && (mode !== r?.operation_mode || r?.money_event_version === 1 || input.enableExplicitAccess) && (!r || r.kind !== 'PHYSICAL' || r.money_event_version !== 1 || !(r.access_control_version === 1 || input.enableExplicitAccess))) fail(409, 'CASH_SHARED_REQUIREMENTS', 'Primero habilita el libro y los accesos de una caja física; después elige Compartida')
  if (mode === 'SHARED' && mode !== r?.operation_mode && (input.authorizedUserIds ?? before.authorized_users.filter(u => u.active).map(u => u.id)).length < 2) fail(409, 'CASH_SHARED_MEMBERS', 'Selecciona al menos dos personas para compartir esta caja')
  const id = r?.id || randomUUID()
  if (input.currencyCode !== undefined) {
    const currency = (await tx.systemSetting.findUnique({ where: { company_id_key: { company_id: scope.companyId, key: 'currency_code' } } }))?.value
    if (input.currencyCode !== currency) fail(409, 'CASH_CONFIGURATION_CURRENCY', 'La moneda debe coincidir con la empresa; no se convierte automáticamente')
    if (r && r.currency_code !== input.currencyCode && await tx.cashRegisterSession.findFirst({ where: { cash_register_id: id }, select: { id: true } })) fail(409, 'CASH_REGISTER_HISTORY', 'Crea otra caja para cambiar moneda con historial')
  }
  if (r && input.active === false) {
    if (r.is_default || before.has_open_session || before.has_pending_closure) fail(409, 'CASH_REGISTER_PENDING_WORK', 'Resuelve el turno, arqueo o caja predeterminada antes de desactivar')
  }
  if (input.authorizedUserIds !== undefined) {
    const owners = await tx.cashRegisterSession.findMany({ where: { cash_register_id: id, status: 'OPEN' }, select: { opened_by_id: true } })
    if (r?.operation_mode !== 'SHARED' && owners.some(owner => before?.authorized_users.some(u => u.id === owner.opened_by_id && u.active) && !input.authorizedUserIds.includes(owner.opened_by_id))) fail(409, 'CASH_REGISTER_OWNER_ACTIVE', 'Termina el turno antes de retirar el acceso de su responsable')
    const members = input.authorizedUserIds.length ? await tx.$queryRaw`SELECT uc.user_id FROM user_companies uc JOIN user_branches ub ON ub.user_id=uc.user_id
      WHERE uc.company_id=${scope.companyId}::uuid AND uc.status='ACTIVE' AND ub.branch_id=${scope.branchId}::uuid AND uc.user_id=ANY(${input.authorizedUserIds}::uuid[])
      ORDER BY uc.user_id FOR UPDATE OF uc,ub` : []
    if (members.length !== input.authorizedUserIds.length) fail(400, 'CASH_REGISTER_USER_MEMBERSHIP', 'Una persona ya no pertenece activamente a esta empresa y sucursal')
    if (r?.access_control_version === 1 && !input.authorizedUserIds.length) fail(409, 'CASH_REGISTER_ACCESS_EMPTY', 'Conserva al menos una persona autorizada')
  }
  if (input.enableExplicitAccess && (!r || !(input.active ?? r.active) || r.money_event_version !== 1 || r.kind !== 'PHYSICAL' || r.operation_mode !== 'INDIVIDUAL' || !r.currency_code || before.has_open_session)) fail(409, 'CASH_REGISTER_ACCESS_REQUIREMENTS', 'El acceso explícito requiere una caja física individual activa, libro habilitado y turno terminado')
  if (!r) {
    if (await tx.cashRegister.findFirst({ where: { branch_id: scope.branchId, code: input.code }, select: { id: true } })) fail(409, 'CASH_REGISTER_CODE_DUPLICATE', 'Ya existe una caja con ese código en la sucursal')
    r = await tx.cashRegister.create({ data: { id, branch_id: scope.branchId, name: input.name, code: input.code, active: input.active ?? true, is_default: false } })
  }
  if (input.isDefault === true && input.active === false) fail(400, 'CASH_REGISTER_DEFAULT_INACTIVE', 'La caja predeterminada debe estar activa')
  if (input.isDefault === true && !(input.active ?? r.active)) fail(400, 'CASH_REGISTER_DEFAULT_INACTIVE', 'Activa la caja antes de marcarla como predeterminada')
  if (input.isDefault === true) await tx.$executeRaw`UPDATE cash_registers SET is_default=false,revision=revision+1,updated_at=now() WHERE branch_id=${scope.branchId}::uuid AND is_default=true AND id<>${id}::uuid`
  if (input.authorizedUserIds !== undefined) {
    await tx.$executeRaw`UPDATE cash_register_access SET active=false WHERE register_id=${id}::uuid AND active AND NOT(user_id=ANY(${input.authorizedUserIds}::uuid[]))`
    for (const userId of input.authorizedUserIds) await tx.$executeRaw`INSERT INTO cash_register_access(company_id,branch_id,register_id,user_id,created_by)
      VALUES(${scope.companyId}::uuid,${scope.branchId}::uuid,${id}::uuid,${userId}::uuid,${scope.userId}::uuid)
      ON CONFLICT(register_id,user_id) DO UPDATE SET active=true`
  }
  if (input.enableExplicitAccess) {
    const [access] = await tx.$queryRaw`SELECT count(*)::int AS n FROM cash_register_access a JOIN user_companies uc ON uc.user_id=a.user_id AND uc.company_id=a.company_id AND uc.status='ACTIVE'
      JOIN user_branches ub ON ub.user_id=a.user_id AND ub.branch_id=a.branch_id WHERE a.register_id=${id}::uuid AND a.active`
    if (!access.n) fail(409, 'CASH_REGISTER_ACCESS_EMPTY', 'Selecciona al menos una persona autorizada antes de habilitar')
  }
  await tx.$executeRaw`UPDATE cash_registers SET name=${input.name},active=${input.active ?? r.active},is_default=${input.isDefault ?? r.is_default},
    currency_code=${input.currencyCode ?? r.currency_code ?? null},operation_mode=${mode}::"CashRegisterOperationMode",access_control_version=CASE WHEN ${input.enableExplicitAccess === true} THEN 1 ELSE access_control_version END,
    revision=revision+${input.id ? 1 : 0},updated_at=now() WHERE id=${id}::uuid`
  const result = await loadRegisterConfiguration(tx, scope, id), commandId = randomUUID()
  await tx.$executeRaw`INSERT INTO cash_register_commands(id,company_id,branch_id,actor_id,request_key,request_hash,action,register_id,before_snapshot,after_snapshot,result_snapshot)
    VALUES(${commandId}::uuid,${scope.companyId}::uuid,${scope.branchId}::uuid,${scope.userId}::uuid,${input.requestKey}::uuid,${hash},${input.enableExplicitAccess ? 'ACCESS_ENABLE' : input.id ? 'CONFIGURE' : 'CREATE'},${id}::uuid,
    ${before ? JSON.stringify(before) : null}::jsonb,${JSON.stringify(result)}::jsonb,${JSON.stringify(result)}::jsonb)`
  return { ...result, command_id: commandId, replayed: false }
}
function parseLegacy(raw, keys) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(k => !keys.includes(k))) fail(400, 'CASH_LEGACY_FIELDS', 'Usa la página de configuración para cambiar accesos o funciones avanzadas')
}
async function legacyRegisterCommand(tx, scope, action, id, raw) {
  requireScope(scope)
  parseLegacy(raw, action === 'create' ? ['name','code'] : action === 'users' ? ['user_ids'] : ['name','active','is_default'])
  for (const key of ['active','is_default']) if (raw[key] !== undefined && typeof raw[key] !== 'boolean') fail(400, 'CASH_BOOLEAN_INVALID', 'El estado debe ser verdadero o falso')
  if (raw.name !== undefined && (typeof raw.name !== 'string' || !raw.name.trim() || raw.name.trim().length > 120)) fail(400, 'CASH_NAME_INVALID', 'Ingresa un nombre válido')
  const branch = await tx.$queryRaw`SELECT id FROM branches WHERE id=${scope.branchId}::uuid AND company_id=${scope.companyId}::uuid FOR NO KEY UPDATE`
  if (!branch.length) fail(404, 'CASH_REGISTER_NOT_FOUND', 'Caja no encontrada')
  if (action === 'create') {
    if (!raw.name) fail(400, 'CASH_NAME_INVALID', 'Ingresa un nombre')
    const code = raw.code || raw.name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,40)
    const input = parseRegisterConfiguration({ name: raw.name, code, requestKey: randomUUID() })
    if (await tx.cashRegister.findFirst({ where: { branch_id: scope.branchId, code: input.code }, select: { id: true } })) fail(409, 'CASH_REGISTER_CODE_DUPLICATE', 'Ya existe una caja con ese código')
    return tx.cashRegister.create({ data: { name: input.name, code: input.code, branch_id: scope.branchId, active: true, is_default: false } })
  }
  if (raw.is_default) await tx.$queryRaw`SELECT id FROM cash_registers WHERE branch_id=${scope.branchId}::uuid ORDER BY id FOR NO KEY UPDATE`
  const r = await registerRow(tx, scope, id, { lock: true })
  if (Number(r.access_control_version || 0) !== 0) fail(409, 'CASH_ADVANCED_CONFIGURATION_REQUIRED', 'Esta caja usa accesos explícitos. Modifícala desde su configuración.')
  if (action === 'users') {
    if (!r.active || !Array.isArray(raw.user_ids) || raw.user_ids.length > 200 || raw.user_ids.some(u => typeof u !== 'string' || !uuid.test(u))) fail(400, 'CASH_USERS_INVALID', 'Selecciona personas válidas para una caja activa')
    const ids = [...new Set(raw.user_ids)].sort()
    const users = ids.length ? await tx.$queryRaw`SELECT u.id,other.branch_id FROM users u LEFT JOIN cash_registers other ON other.id=u.cash_register_id
      WHERE u.id=ANY(${ids}::uuid[]) ORDER BY u.id FOR NO KEY UPDATE OF u` : []
    if (users.some(u => u.branch_id && u.branch_id !== scope.branchId)) fail(409, 'CASH_PREFERENCE_OTHER_BRANCH', 'Una persona tiene su caja sugerida en otra sucursal. No se reemplazará desde aquí.')
    const members = ids.length ? await tx.$queryRaw`SELECT uc.user_id FROM user_companies uc JOIN user_branches ub ON ub.user_id=uc.user_id
      WHERE uc.company_id=${scope.companyId}::uuid AND uc.status='ACTIVE' AND ub.branch_id=${scope.branchId}::uuid AND uc.user_id=ANY(${ids}::uuid[]) ORDER BY uc.user_id FOR UPDATE OF uc,ub` : []
    if (members.length !== ids.length) fail(400, 'CASH_REGISTER_USER_MEMBERSHIP', 'Una persona no pertenece activamente a esta empresa y sucursal')
    await tx.user.updateMany({ where: { cash_register_id: id, ...(ids.length ? { id: { notIn: ids } } : {}) }, data: { cash_register_id: null } })
    if (ids.length) await tx.user.updateMany({ where: { id: { in: ids } }, data: { cash_register_id: id } })
  } else {
    if (raw.active === false) {
      const pending = await tx.cashRegisterSession.findFirst({ where: { cash_register_id: id, OR: [{ status: 'OPEN' }, { status: 'CLOSED', cash_closure_id: null }] }, select: { id: true } })
      if (r.is_default || pending) fail(409, 'CASH_REGISTER_PENDING_WORK', 'Resuelve el turno, arqueo o caja predeterminada antes de desactivar')
    }
    if (raw.is_default && !(raw.active ?? r.active)) fail(400, 'CASH_REGISTER_DEFAULT_INACTIVE', 'La caja predeterminada debe estar activa')
    if (raw.is_default) await tx.$executeRaw`UPDATE cash_registers SET is_default=false,revision=revision+1,updated_at=now() WHERE branch_id=${scope.branchId}::uuid AND is_default AND id<>${id}::uuid`
    await tx.cashRegister.update({ where: { id }, data: { ...(raw.name !== undefined ? { name: raw.name.trim() } : {}), ...(raw.active !== undefined ? { active: raw.active } : {}), ...(raw.is_default !== undefined ? { is_default: raw.is_default } : {}) } })
  }
  await tx.$executeRaw`UPDATE cash_registers SET revision=revision+1 WHERE id=${id}::uuid`
  return { ...await registerRow(tx, scope, id), ...(action === 'users' ? { assigned_users: await tx.user.findMany({ where: { cash_register_id: id }, select: { id: true, name: true }, orderBy: { name: 'asc' } }) } : {}) }
}
module.exports = { parseRegisterConfiguration, registerConfigurationHash, registerConfigurationAvailable, loadRegisterConfiguration, listEligibleRegisterUsers, saveRegisterConfiguration, legacyRegisterCommand, parseLegacy }
