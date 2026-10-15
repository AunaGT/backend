const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto')
const {withAppointmentsTestDb,seedAgenda}=require('./helpers/appointmentsTestDb.cjs')
const {activityInput}=require('./helpers/agendaActivityFixture.cjs')
const app=require('../src/modules/appointments/application')
const {parseActivity,activityInterval}=require('../src/modules/appointments/domain/activities')
async function storeActivity(db,scope,raw) {
  const {assertActivityAvailability}=require('../src/modules/appointments/occupancy')
  return app.withAgendaTransaction(db,scope.companyId,async tx=>{
    const input=parseActivity(raw)
    await assertActivityAvailability(tx,scope,input)
    const r=activityInterval(input)
    return tx.appointmentSession.create({data:{company_id:scope.companyId,branch_id:scope.branchId,record_type:'ACTIVITY',
      purpose:input.purpose,title:input.title,organizer_id:input.organizerId,mode:'INDIVIDUAL',capacity:1,
      starts_at:new Date(r.startsAt),ends_at:new Date(r.endsAt),occupied_from:new Date(r.occupiedFrom),occupied_until:new Date(r.occupiedUntil),
      timezone:input.timezone,policy_snapshot:{},created_by:scope.userId}})
  })
}
test('misma identidad usuario/prestador compite entre sucursales y no filtra detalles',async()=>withAppointmentsTestDb(async context=>{
  await seedAgenda(context)
  const {db,scope,fixtures:f}=context
  const {resolveBusyIdentities,assertActivityAvailability}=require('../src/modules/appointments/occupancy')
  const identities=await resolveBusyIdentities(db,scope,{userIds:[f.userId],providerIds:[]})
  assert.deepEqual(identities.providerIds,[f.providerId])
  const raw=activityInput(f)
  const row=await storeActivity(db,scope,raw)
  await assert.rejects(()=>app.createBooking(db,{...scope,branchId:f.secondBranchId},f.individualInput),{status:409})
  await assert.rejects(()=>assertActivityAvailability(db,scope,parseActivity(raw)),error=>{
    assert.equal(error.status,409)
    assert.equal(JSON.stringify(error).includes(row.id),false)
    assert.equal(JSON.stringify(error).includes(raw.title),false)
    return true
  })
  const edge=activityInput(f,{startsAt:row.ends_at.toISOString(),endsAt:new Date(row.ends_at.getTime()+3600000).toISOString()})
  await assertActivityAvailability(db,scope,parseActivity(edge))
  await db.appointmentSession.update({where:{id:row.id},data:{status:'CANCELLED'}})
  await app.createBooking(db,scope,f.individualInput)
  await assert.rejects(()=>storeActivity(db,{...scope,branchId:f.secondBranchId},raw),{status:409})
}))
test('carrera real entre reunión y atención solo confirma una ocupación',async()=>withAppointmentsTestDb(async context=>{
  await seedAgenda(context)
  const {db,scope,fixtures:f}=context
  let release,ready
  const gate=new Promise(r=>{release=r}),entered=new Promise(r=>{ready=r})
  const holder=app.withAgendaTransaction(db,scope.companyId,async()=>{ready();await gate})
  await entered
  const results=Promise.allSettled([storeActivity(db,scope,activityInput(f)),app.createBooking(db,{...scope,branchId:f.secondBranchId},{...f.individualInput,idempotencyKey:crypto.randomUUID()})])
  try {
    const until=Date.now()+5000
    let waiting=0
    while(waiting<2&&Date.now()<until) {
      const [row]=await db.$queryRaw`SELECT count(*)::int AS count FROM pg_locks WHERE locktype='advisory' AND NOT granted`
      waiting=row.count
    }
    assert.ok(waiting>=2)
  } finally {release();await holder}
  const settled=await results
  assert.equal(settled.filter(r=>r.status==='fulfilled').length,1)
  assert.equal(settled.find(r=>r.status==='rejected').reason.status,409)
}))
test('actividad sin horario funciona, pero ausencia de su usuario sin prestador también restringe',async()=>withAppointmentsTestDb(async({db,scope,fixtures:f})=>{
  const {assertActivityAvailability}=require('../src/modules/appointments/occupancy')
  const input=parseActivity(activityInput(f))
  await assertActivityAvailability(db,scope,input)
  await db.serviceProviderBranch.deleteMany({where:{provider_id:f.providerId}})
  await db.serviceProvider.delete({where:{id:f.providerId}})
  const employee=await db.employee.create({data:{company_id:scope.companyId,branch_id:scope.branchId,user_id:f.userId,
    code:'QA',first_name:'QA',last_name:'Usuario',hire_date:new Date('2020-01-01'),base_salary:'100',status:'ACTIVO'}})
  const day=input.startsAt.slice(0,10)
  await db.attendance.create({data:{company_id:scope.companyId,branch_id:scope.branchId,employee_id:employee.id,
    work_date:new Date(`${day}T00:00Z`),status:'AUSENTE'}})
  await assert.rejects(()=>assertActivityAvailability(db,scope,input),{status:409,code:'ABSENCE_CONFLICT'})
}))
test('vincular prestador con ocupaciones a otro usuario no permite cruces existentes',async()=>withAppointmentsTestDb(async context=>{
  await seedAgenda(context)
  const {db,scope,fixtures:f}=context
  const {saveProvider}=require('../src/modules/appointments/directory')
  await app.createBooking(db,scope,f.individualInput)
  const second=await db.user.create({data:{name:'Otra persona',email:`${crypto.randomUUID()}@example.invalid`,password:'QA',role_id:(await db.user.findUnique({where:{id:f.userId}})).role_id}})
  await db.userCompany.create({data:{user_id:second.id,company_id:scope.companyId}})
  await db.userBranch.create({data:{user_id:second.id,branch_id:scope.branchId}})
  await storeActivity(db,scope,activityInput(f,{organizerId:second.id}))
  await assert.rejects(()=>app.withAgendaTransaction(db,scope.companyId,tx=>saveProvider(tx,scope,f.providerId,
    {name:'Reasignado',employeeId:null,userId:second.id,branchIds:scope.branchIds,active:true,expectedVersion:1})),{status:409})
  assert.equal((await db.serviceProvider.findUnique({where:{id:f.providerId}})).user_id,f.userId)
}))
