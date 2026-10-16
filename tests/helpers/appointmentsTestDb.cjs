const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')
const { PrismaClient } = require('@prisma/client')
const root = path.resolve(__dirname, '../..')
const historicalPath=name=>require('../../scripts/migrationFiles').migrationSqlPath(name,{historical:true})
const migrationPath=historicalPath('202610120002_appointments_core')
const flexibleMigrationPath=historicalPath('202610120003_appointments_flexible')
const unifiedMigrationPath=historicalPath('202610120004_appointments_unified_services')
const commercialMigrationPath=historicalPath('202610130001_appointments_commercial')
const baselineSql = new Map()

function appointmentsTestUrl(env = process.env) {
  const raw = env.APPOINTMENTS_TEST_DATABASE_URL
  if (!raw) throw Error('Define APPOINTMENTS_TEST_DATABASE_URL para una base local de pruebas')
  const url = new URL(raw)
  if (!['postgresql:', 'postgres:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw Error('Las pruebas de Agenda solo aceptan una base local aislada; no staging ni producción')
  }
  url.searchParams.delete('schema')
  return url.toString()
}
function statements(sql) { return sql.replace(/^--[^\n]*$/gm, '').split(';').map(value => value.trim()).filter(Boolean) }
function parentSql(url, migration, version) {
  if (baselineSql.has(version)) return baselineSql.get(version)
  const commercialSql=fs.readFileSync(commercialMigrationPath,'utf8')
  const ownedSql = migration + fs.readFileSync(flexibleMigrationPath, 'utf8')+fs.readFileSync(unifiedMigrationPath,'utf8')+commercialSql
  const newTables = [...ownedSql.matchAll(/CREATE TABLE "([^"]+)"/g)].map(match => match[1])
  const sql = execFileSync(process.execPath, [require.resolve('prisma/build/index.js'), 'migrate', 'diff', '--from-empty', '--to-schema-datamodel', path.join(root, 'prisma/schema.prisma'), '--script'], {
    cwd: root, env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 4 * 1024 * 1024,
  }).replaceAll('"public".', '')
    .replace(/^    "(?:settlement_source|service_schedule_snapshot)"[^\n]*\n/gm,'')
    .replace(/, 'CUSTOMER_ADVANCE', 'CUSTOMER_ADVANCE_APPLIED', 'CUSTOMER_PAYMENT_REFUND'/g,'')
  const commercialIndexes=[...commercialSql.matchAll(/CREATE (?:UNIQUE )?INDEX "([^"]+)"/g)].map(match=>match[1])
  const parents = statements(sql).filter(statement =>
    !/^CREATE SCHEMA\b/.test(statement) &&
    !newTables.some(table => statement.includes(`"${table}"`)) &&
    !commercialIndexes.some(index=>statement.includes(`"${index}"`)) &&
    !/^CREATE UNIQUE INDEX "(?:branches|products|suppliers|employees)_company_id_id_key"/.test(statement))
  baselineSql.set(version, parents)
  return parents
}
async function applyFlexibleMigration(db) {
  const sql=fs.readFileSync(flexibleMigrationPath,'utf8')
  if (/"public"\.|^(?:DROP|TRUNCATE|DELETE|UPDATE)\b/m.test(sql)) throw Error('La migración no está aislada o no es aditiva')
  await db.$transaction(async tx=>{
    for(const statement of statements(sql)) await tx.$executeRawUnsafe(statement)
  },{timeout:60000,maxWait:5000})
}
async function applyUnifiedMigration(db){
  await db.$transaction(async tx=>{
    for(const statement of statements(fs.readFileSync(unifiedMigrationPath,'utf8'))) await tx.$executeRawUnsafe(statement)
  },{timeout:60000,maxWait:5000})
}
async function applyCommercialMigration(db){
  await db.$transaction(async tx=>{
    for(const statement of statements(fs.readFileSync(commercialMigrationPath,'utf8'))) await tx.$executeRawUnsafe(statement)
  },{timeout:60000,maxWait:5000})
}
async function withAppointmentsTestDb(run, {version='commercial'}={}) {
  if (!['core','flexible','unified','commercial'].includes(version)) throw Error('Versión de ensayo desconocida')
  const url = appointmentsTestUrl()
  const schema = `appointments_qa_${crypto.randomUUID().replaceAll('-', '')}`
  const admin = new PrismaClient({ datasources: { db: { url } } })
  const scopedUrl = new URL(url)
  scopedUrl.searchParams.set('schema', schema)
  const db = new PrismaClient({ datasources: { db: { url: scopedUrl.toString() } } })
  let created = false
  try {
    const migration = fs.readFileSync(migrationPath, 'utf8')
    if (/"public"\.|^(?:DROP|TRUNCATE|DELETE|UPDATE)\b/m.test(migration)) throw Error('La migración no está aislada o no es aditiva')
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`)
    created = true
    await db.$transaction(async tx => {
      await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}"`)
      for (const statement of parentSql(url, migration, version)) await tx.$executeRawUnsafe(statement)
      for (const statement of statements(migration)) await tx.$executeRawUnsafe(statement)
      if (version!=='core') for(const statement of statements(fs.readFileSync(flexibleMigrationPath,'utf8'))) await tx.$executeRawUnsafe(statement)
      if (['unified','commercial'].includes(version)) for(const statement of statements(fs.readFileSync(unifiedMigrationPath,'utf8'))) await tx.$executeRawUnsafe(statement)
      if (version==='commercial') for(const statement of statements(fs.readFileSync(commercialMigrationPath,'utf8'))) await tx.$executeRawUnsafe(statement)
    }, { timeout: 60000, maxWait: 5000 })
    const ids = Array.from({ length: 12 }, () => crypto.randomUUID())
    const [companyId, branchId, secondBranchId, userId, productId, contactId, providerId, resourceId, groupSessionId, confirmedBookingId] = ids
    const company = await db.company.create({ data: { id: companyId, name: 'Agenda QA', code: companyId.slice(0, 16) } })
    const branches = []
    for (const [id, code] of [[branchId, 'QA1'], [secondBranchId, 'QA2']]) branches.push(await db.branch.create({ data: { id, company_id: companyId, name: code, code } }))
    const role = await db.role.create({ data: { name: `qa-${companyId}` } })
    await db.user.create({ data: { id: userId, name: 'Recepción QA', email: `${userId}@example.invalid`, password: 'not-a-real-login', role_id: role.id } })
    await db.userCompany.create({ data: { user_id: userId, company_id: companyId } })
    await db.userBranch.createMany({ data: branches.map(branch => ({ user_id: userId, branch_id: branch.id })) })
    await db.companyModule.create({ data: { company_id: companyId, module_code: 'appointments', status: 'ACTIVE' } })
    await db.systemSetting.create({ data: { company_id: companyId, key: 'inventory_services_enabled', value: 'true', type: 'boolean' } })
    const category = await db.productCategory.create({ data: { company_id: companyId, name: 'Servicios QA' } })
    const status = await db.stockStatus.create({ data: { name: 'Disponible' } })
    await db.product.create({ data: { id: productId, company_id: companyId, name: 'Consulta QA', category_id: category.id, kind: 'SERVICE', service_unit_label: 'Sesión', quantity_decimals: 0, price: '150', cost: '0', status_id: status.id } })
    await db.supplier.create({ data: { id: contactId, company_id: companyId, name: 'Cliente QA', contact: 'Cliente QA', party_type: 'CUSTOMER' } })
    await db.serviceProvider.create({ data: { id: providerId, company_id: companyId, name: 'Profesional QA', user_id: userId, created_by: userId } })
    await db.serviceProviderBranch.createMany({ data: branches.map(branch => ({ company_id: companyId, provider_id: providerId, branch_id: branch.id })) })
    if(version==='core') await db.$executeRaw`INSERT INTO schedule_resources (id,company_id,branch_id,name,type,person_capacity,updated_at) VALUES (${resourceId}::uuid,${companyId}::uuid,${branchId}::uuid,'Sala QA','ROOM',5,NOW())`
    else await db.scheduleResource.create({ data: { id: resourceId, company_id: companyId, branch_id: branchId, name: 'Sala QA', type: 'ROOM', person_capacity: 5 },select:{id:true} })
    const scope = { companyId, branchId, branchIds: [branchId, secondBranchId], userId, permissions: [], isAdmin: true }
    const now = new Date()
    const startsAt = require('luxon').DateTime.now().setZone('America/Guatemala').plus({ days: 1 }).set({ hour: 9, minute: 0, second: 0, millisecond: 0 }).toUTC().toISO()
    const individualInput = { productId, contactId, startsAt, timezone: 'America/Guatemala', providerIds: [providerId], resourceIds: [], quantity: '1', notes: '', idempotencyKey: crypto.randomUUID() }
    await run({ db, scope, schema, fixtures: { company, companyId, branchId, secondBranchId, userId, productId, contactId, providerId, resourceId, groupSessionId, confirmedBookingId, individualInput, now } })
  } finally {
    await db.$disconnect()
    try { if (created) await admin.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`) }
    finally { await admin.$disconnect() }
  }
}
async function seedAgenda({ db, scope, fixtures: f }) {
  const { saveServiceProfile } = require('../../src/modules/appointments/profiles')
  const { saveCalendar } = require('../../src/modules/appointments/calendars')
  const { withAgendaTransaction } = require('../../src/modules/appointments/application')
  const profile = { enabled: true, mode: 'INDIVIDUAL', durationMinutes: 45, beforeMinutes: 0, afterMinutes: 0, intervalMinutes: 15, leadMinutes: 0, horizonDays: 60, cancellationHours: 24, confirmation: 'AUTOMATIC', capacity: 1, requiresProvider: true, requiresResource: false, branchIds: scope.branchIds, providerIds: [f.providerId], resourceIds: [], instructions: '' }
  const calendar = { timezone: 'America/Guatemala', expectedVersion: 0, weekly: Array.from({ length: 7 }, (_, i) => ({ weekday: i + 1, from: '00:00', to: '24:00' })), exceptions: [] }
  await withAgendaTransaction(db, scope.companyId, async tx => {
    for (const branch of scope.branchIds) await saveCalendar(tx, scope, 'branch', branch, calendar)
    await saveCalendar(tx, scope, 'provider', f.providerId, { ...calendar, weekly: [], inheritBranch: true })
    await saveCalendar(tx, scope, 'resource', f.resourceId, { ...calendar, weekly: [], inheritBranch: true })
    await saveServiceProfile(tx, scope, f.productId, profile)
  })
  f.groupProductId = crypto.randomUUID()
  const product = await db.product.findUnique({ where: { id: f.productId } })
  await db.product.create({ data: { id: f.groupProductId, company_id: scope.companyId, category_id: product.category_id, status_id: product.status_id, name: 'Clase QA', kind: 'SERVICE', service_unit_label: 'Sesión', quantity_decimals: 0, price: '75', cost: '0' } })
  await withAgendaTransaction(db, scope.companyId, tx => saveServiceProfile(tx, scope, f.groupProductId, { ...profile, mode: 'GROUP', capacity: 2, branchIds: [scope.branchId], requiresResource: true, resourceIds: [f.resourceId] }))
  const { createSession, enrollBooking } = require('../../src/modules/appointments/application')
  const { contactId, quantity, ...sessionInput } = f.individualInput
  const session = await createSession(db, scope, { ...sessionInput, productId: f.groupProductId, startsAt: new Date(new Date(f.individualInput.startsAt).getTime() + 86400000).toISOString(), capacity: 2, resourceIds: [f.resourceId] })
  f.groupSessionId = session.id
  const booking = await enrollBooking(db, scope, session.id, { contactId: f.contactId, quantity: '1', notes: '', idempotencyKey: crypto.randomUUID() })
  f.confirmedBookingId = booking.id
}
module.exports = { appointmentsTestUrl, withAppointmentsTestDb, seedAgenda, applyFlexibleMigration,applyUnifiedMigration,applyCommercialMigration }
