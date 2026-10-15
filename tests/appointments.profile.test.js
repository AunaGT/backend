require('./setup-env')
const test = require('node:test'), assert = require('node:assert/strict')
const path = require('node:path')
const { withMocks, jsonResponse } = require('./helpers/reportHarness.cjs')
const { saveServiceProfile, getServiceProfile } = require('../src/modules/appointments/profiles')
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const scope = { companyId: id(1), branchId: id(2), branchIds: [id(2)], userId: id(3), isAdmin: false, permissions: ['appointments.view', 'appointments.configure','products.view'] }
const input = { enabled: true, mode: 'INDIVIDUAL', durationMinutes: 45, beforeMinutes: 0, afterMinutes: 0,
  intervalMinutes: 15, leadMinutes: 0, horizonDays: 60, cancellationHours: 24, confirmation: 'AUTOMATIC', capacity: 1,
  requiresProvider: true, requiresResource: false, branchIds: [id(2)], providerIds: [id(5)], resourceIds: [], instructions: '' }
function fixture() {
  let row = null
  const writes = []
  const db = {
    companyModule: { findMany: async () => [{ module_code: 'appointments', status: 'ACTIVE' }] },
    systemSetting: { findUnique: async () => ({ value: 'true' }) },
    product: { findFirst: async ({ where }) => where.company_id === scope.companyId && where.id === id(4) ? { id: id(4), company_id: scope.companyId, kind: 'SERVICE', deleted: false } : null },
    branch: { findMany: async ({where}) => [{ id: id(2), company_id: scope.companyId, active: true }].filter(r=>where.id.in.includes(r.id)) },
    serviceProvider: { findMany: async ({where}) => [{ id: id(5), company_id: scope.companyId, active: true, branches: [{ branch_id: id(2) }] }].filter(r=>where.id.in.includes(r.id)) },
    scheduleResource: { findMany: async () => [] },
    serviceScheduleProfile: {
      findFirst: async () => row,
      create: async ({ data }) => { row = { id: id(6), ...data }; writes.push(data); return row },
      updateMany: async ({ where, data }) => {
        if (row?.version !== where.version) return { count: 0 }
        row = { ...row, ...data, version: row.version + 1 }; writes.push(data); return { count: 1 }
      },
    },
  }
  for (const model of ['serviceScheduleBranch', 'serviceScheduleProvider', 'serviceScheduleResource']) db[model] = {
    deleteMany: async () => ({}), createMany: async ({ data }) => { writes.push({ model, data }); return { count: data.length } },
  }
  return { db, writes, setRow: value => { row = value } }
}
test('ambos requisitos desmarcados permiten servicio habilitado sin asignaciones',async()=>{
  const {db}=fixture();db.serviceProvider.findMany=async()=>[]
  const result=await saveServiceProfile(db,scope,id(4),{...input,requiresProvider:false,providerIds:[]})
  assert.equal(result.profile.requiresProvider,false);assert.equal(result.profile.requiresResource,false)
})
test('cada requisito independiente exige solo su cobertura',async()=>{
  for(const [requiresProvider,requiresResource] of [[true,false],[false,true],[true,true]]){
    const {db}=fixture()
    db.scheduleResource.findMany=async()=>[{id:id(7),branch_id:id(2),type:'EQUIPMENT',portable:true}]
    const result=await saveServiceProfile(db,scope,id(4),{...input,requiresProvider,requiresResource,resourceIds:requiresResource?[id(7)]:[]})
    assert.equal(result.profile.requiresProvider,requiresProvider)
    assert.equal(result.profile.requiresResource,requiresResource)
  }
})
test('falta de sucursal o cobertura tiene campo concreto y no escribe',async()=>{
  for(const [patch,field] of [[{branchIds:[]},'branchIds'],[{providerIds:[]},'providerIds'],[{requiresProvider:false,requiresResource:true},'resourceIds']]){
    const {db,writes}=fixture()
    await assert.rejects(()=>saveServiceProfile(db,scope,id(4),{...input,...patch}),e=>e.fields?.[field]!=null)
    assert.equal(writes.length,0)
  }
})
test('sala fija no cubre requisito para domicilio',async()=>{
  const {db,writes}=fixture();db.scheduleResource.findMany=async()=>[{id:id(7),branch_id:id(2),type:'ROOM',portable:false}]
  await assert.rejects(()=>saveServiceProfile(db,scope,id(4),{...input,requiresResource:true,resourceIds:[id(7)],allowedVenueKinds:['HOME']}),e=>!!e.fields?.resourceIds)
  assert.equal(writes.length,0)
})
test('perfil guarda reglas y asignaciones sin cambiar cantidad ni precio del servicio', async () => {
  const { db, writes } = fixture()
  const result = await saveServiceProfile(db, scope, id(4), input)
  assert.equal(result.version, 1)
  assert.equal(result.profile.durationMinutes, 45)
  assert.equal(result.profile.capacity, 1)
  assert.deepEqual(result.profile.providerIds, [id(5)])
  assert.equal(writes[0].duration_minutes, 45)
  assert.equal(Object.hasOwn(writes[0], 'price'), false)
  assert.equal(Object.hasOwn(writes[0], 'service_unit_label'), false)
})
test('old profile updates preserve public instructions and explicit edits can clear them',async()=>{
  const {db}=fixture()
  await saveServiceProfile(db,scope,id(4),{...input,publicInstructions:'Público'})
  const old=await saveServiceProfile(db,scope,id(4),{...input,expectedVersion:1})
  assert.equal(old.profile.publicInstructions,'Público')
  const cleared=await saveServiceProfile(db,scope,id(4),{...input,publicInstructions:'',expectedVersion:2})
  assert.equal(cleared.profile.publicInstructions,'')
})
test('perfil niega ajenos/físicos, permiso y versión vieja antes de escribir', async () => {
  const { db, writes, setRow } = fixture()
  await assert.rejects(() => saveServiceProfile(db, scope, id(99), input), { status: 404 })
  db.product.findFirst = async () => ({ kind: 'STANDARD' })
  await assert.rejects(() => saveServiceProfile(db, scope, id(4), input), { status: 400 })
  await assert.rejects(() => saveServiceProfile(db, { ...scope, permissions: ['appointments.view'] }, id(4), input), { status: 403 })
  db.product.findFirst = async () => ({ kind: 'SERVICE' })
  setRow({ id: id(6), version: 3 })
  await assert.rejects(() => saveServiceProfile(db, scope, id(4), { ...input, expectedVersion: 2 }), { status: 409 })
  assert.equal(writes.length, 0)
})
test('habilitado requiere asignación en cada sucursal y un borrador no inventa disponibilidad', async () => {
  const { db, writes } = fixture()
  db.serviceProvider.findMany = async () => []
  await assert.rejects(() => saveServiceProfile(db, scope, id(4), input), { status: 400 })
  assert.equal(writes.length, 0)
  const result = await saveServiceProfile(db, scope, id(4), { ...input, enabled: false, providerIds: [] })
  assert.equal(result.profile.enabled, false)
  await assert.rejects(() => saveServiceProfile(db, scope, id(4), { ...input, expectedVersion: 1, branchIds: [id(99)] }), { status: 403 })
})
test('sin perfil devuelve null solo para servicio accesible, no revela producto ajeno', async () => {
  const { db } = fixture()
  assert.equal(await getServiceProfile(db, scope, id(4)), null)
  await assert.rejects(() => getServiceProfile(db, scope, id(99)), { status: 404 })
})
test('create SERVICE revierte producto si falla su perfil y no devuelve éxito parcial', async () => {
  let committed = false
  const { db } = fixture()
  db.productCategory = { findFirst: async () => ({ id: 1 }) }
  db.stockStatus = { findFirst: async () => ({ id: 1 }) }
  db.product.create = async ({ data }) => ({ id: id(4), ...data })
  db.$executeRaw = async () => 1
  db.$transaction = async run => { const value = await run(db); committed = true; return value }
  const res = jsonResponse()
  await withMocks({ [require.resolve('../src/models/prisma')]: { prisma: db, prismaTransaction: db } }, path.resolve(__dirname, '../src/modules/inventory/products.controller.js'), async controller => {
    await assert.rejects(() => controller.create({ companyId: scope.companyId, branchId: scope.branchId,
      user: { sub: scope.userId, permissions: scope.permissions }, body: { kind: 'SERVICE', name: 'Consulta',
        service_unit_label: 'Sesión', quantity_decimals: 0, price: '150', category_id: 1,
        schedule_profile: { ...input, durationMinutes: 0 } } }, res, error => { throw error }), { status: 400 })
  })
  assert.equal(committed, false)
  assert.equal(res.body, null)
})
