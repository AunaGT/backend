const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
require('./setup-env')
const { withMocks } = require('./helpers/reportHarness.cjs')
const { resolveEffectiveModules } = require('../src/modules/platform/registry')
const { expandPermissions } = require('../src/config/permissionDeps')
const { requestScope, appointmentWhere, assertAgendaWrite, assertAppointmentsEnabled, agendaCapabilities, assertCatalogIntegration, assertContactsIntegration } = require('../src/modules/appointments/access')
const scope = { companyId: 'company-a', branchId: 'branch-a', branchIds: ['branch-a'], userId: 'user-a', permissions: ['appointments.view'], isAdmin: false }
test('propio permite reserva sin prestador creada por el usuario sin conceder equipo',()=>{
  const where=appointmentWhere(scope)
  assert.ok(where.OR.some(r=>r.record_type==='SCHEDULED_SERVICE'&&r.created_by===scope.userId&&r.providers?.none))
  assert.equal(where.company_id,scope.companyId);assert.equal(where.branch_id,scope.branchId)
})
test('agenda es opt-in y las dependencias no activan otros módulos', () => {
  const modules = resolveEffectiveModules([])
  assert.equal(modules.find(item => item.code === 'appointments')?.effectiveEnabled, false)
  assert.equal(modules.filter(item => item.code !== 'appointments').every(item => item.effectiveEnabled), true)
  const enabled = resolveEffectiveModules([{ module_code: 'appointments', status: 'ACTIVE' }, { module_code: 'inventory', status: 'DISABLED' }])
  assert.equal(enabled.find(item => item.code === 'appointments')?.effectiveEnabled, true)
})
test('crear Agenda no concede consulta comercial, configurar no otorga editar catálogo ni ver equipo', () => {
  const create = expandPermissions(['appointments.create'])
  assert.deepEqual(create.sort(),['appointments.create','appointments.view'])
  const configure = expandPermissions(['appointments.configure'])
  assert.ok(configure.includes('appointments.view'))
  for (const code of ['products.edit', 'appointments.view_team', 'hr.employees.view']) assert.equal(configure.includes(code), false)
})
test('scope sin sesión o empresa falla cerrado; propio/equipo siempre conserva tenant y sucursal', () => {
  assert.throws(() => requestScope({ companyId: 'company-a' }), { status: 401 })
  assert.throws(() => requestScope({ user: { sub: 'u', permissions: ['appointments.view'] } }), { status: 400 })
  assert.throws(() => requestScope({ user: { sub: 'u', permissions: [] }, companyId: 'a', branchId: 'b' }), { status: 403 })
  const own = appointmentWhere(scope)
  assert.equal(own.company_id, 'company-a')
  assert.equal(own.branch_id, 'branch-a')
  assert.ok(own.OR[0].providers.some.provider.OR.some(item => item.user_id === 'user-a'))
  const team = appointmentWhere({ ...scope, permissions: ['appointments.view', 'appointments.view_team'] })
  assert.deepEqual(team, { company_id: 'company-a', branch_id: 'branch-a' })
  assert.throws(() => assertAgendaWrite({ ...scope, branchId: null }), { status: 400 })
})
test('Agenda permite actividades con servicios apagados pero bloquea nuevas integraciones', async () => {
  const db = { companyModule: { findMany: async () => [{ module_code: 'appointments', status: 'ACTIVE' }] },
    systemSetting: { findUnique: async () => ({ value: 'false' }) } }
  await assertAppointmentsEnabled(db, scope)
  assert.equal((await agendaCapabilities(db,scope)).catalog,false)
  await assert.rejects(()=>assertCatalogIntegration(db,scope),{status:403})
  await assert.rejects(()=>assertContactsIntegration(db,scope),{status:403})
  db.systemSetting.findUnique = async () => ({ value: 'true' })
  await assertAppointmentsEnabled(db, scope)
  await assertCatalogIntegration(db,{...scope,permissions:['products.view']})
  await assertContactsIntegration(db,{...scope,permissions:['contacts.clients.view']})
  db.companyModule.findMany=async()=>[{module_code:'appointments',status:'ACTIVE'},
    {module_code:'inventory',status:'DISABLED'},{module_code:'contacts',status:'DISABLED'},{module_code:'hr',status:'DISABLED'}]
  await assertAppointmentsEnabled(db,scope)
  assert.deepEqual(await agendaCapabilities(db,scope),{catalog:false,contacts:false,hr:false})
  db.companyModule.findMany = async () => []
  await assert.rejects(() => assertAppointmentsEnabled(db, scope), { status: 403 })
})
test('seed y upsert sin estado no habilitan Agenda; activación explícita no depende de servicios', async () => {
  let seeded, write
  const db = { companyModule: { createMany: async input => { seeded = input.data }, findMany: async () => [],
    upsert: async input => { write = input } }, systemSetting: { findUnique: async () => ({ value: 'false' }) } }
  await withMocks({ [require.resolve('../src/models/prisma')]: { prisma: db } }, path.resolve(__dirname, '../src/modules/platform/service.js'), async service => {
    await service.seedCompanyModules(db, 'company-a')
    const agenda = seeded.find(item => item.module_code === 'appointments')
    assert.equal(agenda.status, 'DISABLED'); assert.equal(agenda.activated_at, null)
    assert.equal(seeded.filter(item => item.module_code !== 'appointments').every(item => item.status === 'ACTIVE'), true)
    await service.updateCompanyModule('company-a', 'appointments', { config: {} })
    assert.equal(write.create.status, 'DISABLED'); assert.equal(write.create.activated_at, null)
    write = null
    await service.updateCompanyModule('company-a', 'appointments', { status: 'ACTIVE' })
    assert.equal(write.create.status, 'ACTIVE')
  })
})
test('directorios comerciales fallan antes de consultar maestros deshabilitados',async()=>{
  const {listServices,listContacts}=require('../src/modules/appointments/queries')
  let reads=0
  const forbidden=async()=>{reads++; throw Error('No consultar maestro apagado')}
  const db={companyModule:{findMany:async()=>[{module_code:'appointments',status:'ACTIVE'},
    {module_code:'inventory',status:'DISABLED'},{module_code:'contacts',status:'DISABLED'}]},
    product:{findMany:forbidden,count:forbidden},supplier:{findMany:forbidden,count:forbidden}}
  await assert.rejects(()=>listServices(db,{...scope,isAdmin:true}),{status:403})
  await assert.rejects(()=>listContacts(db,{...scope,isAdmin:true}),{status:403})
  assert.equal(reads,0)
})
test('permiso de crear reuniones no revela importes guardados en una reserva',()=>{
  const {presentBooking}=require('../src/modules/appointments/presentation')
  const dto=presentBooking({id:'b',session_id:'s',contact_id:'c',branch_id:'branch-a',status:'CONFIRMED',version:1,
    commercial_snapshot:{name:'Consulta',unitPrice:'150'},session:{product_id:'p',providers:[],resources:[]}},
    {...scope,permissions:['appointments.view','appointments.create']})
  assert.equal(dto.commercial,null)
})
test('lectura histórica no consulta producto/contacto cuando integraciones están apagadas',async()=>{
  const {getBooking}=require('../src/modules/appointments/queries')
  const id='00000000-0000-4000-8000-000000000001'
  const db={companyModule:{findMany:async()=>[{module_code:'appointments',status:'ACTIVE'},
    {module_code:'inventory',status:'DISABLED'},{module_code:'contacts',status:'DISABLED'}]},
    appointmentBooking:{findFirst:async({include})=>{
      assert.equal(!!include.contact,false,'No consultar contactos deshabilitados')
      assert.equal(!!include.session.include.product,false,'No consultar catálogo deshabilitado')
      return {id,session_id:'s',contact_id:'c',branch_id:'branch-a',status:'COMPLETED',version:1,
        commercial_snapshot:{name:'Histórico',unitPrice:'150'},session:{id:'s',product_id:'p',providers:[],resources:[],
          starts_at:new Date('2030-01-01T15:00Z'),ends_at:new Date('2030-01-01T16:00Z'),
          occupied_from:new Date('2030-01-01T15:00Z'),occupied_until:new Date('2030-01-01T16:00Z')}}}},
    scheduleCalendar:{findMany:async()=>[]},serviceProvider:{findMany:async()=>[]},scheduleResource:{findMany:async()=>[]},
    appointmentHistory:{findMany:async()=>[]}}
  const dto=await getBooking(db,scope,id)
  assert.equal(dto.serviceName,'Histórico'); assert.equal(dto.contactName,'')
  assert.equal(dto.commercial,null)
})
