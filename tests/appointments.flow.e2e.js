const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto')
const {withAppointmentsTestDb,seedAgenda}=require('./helpers/appointmentsTestDb.cjs')
const app=require('../src/modules/appointments/application'),q=require('../src/modules/appointments/queries')
test('cita nocturna aparece al consultar el día y la semana siguientes; crear y mover ofrecen23:45',async()=>withAppointmentsTestDb(async context=>{
  await seedAgenda(context);const {db,scope,fixtures:f}=context
  const day=require('luxon').DateTime.fromISO(f.individualInput.startsAt).setZone('America/Guatemala').plus({weeks:1}).startOf('week').minus({days:1})
  const startsAt=day.set({hour:23,minute:45}).toUTC().toISO(),from=day.startOf('day').toUTC().toISO(),to=day.plus({days:1}).startOf('day').toUTC().toISO()
  const input={productId:f.productId,from,to}
  assert.ok((await q.readAvailability(db,scope,input)).some(s=>s.startsAt===startsAt))
  const booking=await app.createBooking(db,scope,{...f.individualInput,startsAt})
  assert.ok((await q.readMoveAvailability(db,scope,'booking',booking.id,input)).some(s=>s.startsAt===startsAt))
  const filter={from:to,to:day.plus({days:2}).startOf('day').toUTC().toISO(),productId:f.productId}
  assert.equal((await q.listSessions(db,scope,filter)).items[0]?.id,booking.sessionId)
  assert.equal((await q.listBookings(db,scope,filter)).totalItems,1)
  assert.equal((await q.readSummary(db,scope,filter)).reservations,1)
  assert.equal((await q.listSessions(db,scope,{...filter,to:day.plus({days:8}).startOf('day').toUTC().toISO()})).totalItems,1)
}))
test('finalizar grupo no fabrica asistencia ni impide completar o resolver ausentes explícitamente',async()=>withAppointmentsTestDb(async context=>{
  await seedAgenda(context);const {db,scope,fixtures:f}=context
  const old=new Date(Date.now()-7200000),end=new Date(Date.now()-3600000)
  await db.appointmentSession.update({where:{id:f.groupSessionId},data:{starts_at:old,ends_at:end,occupied_from:old,occupied_until:end,status:'IN_PROGRESS'}})
  const action=(name,v)=>({action:name,expectedVersion:v,reason:'',idempotencyKey:crypto.randomUUID()})
  await app.transitionBooking(db,scope,f.confirmedBookingId,action('ARRIVE',1));await app.transitionBooking(db,scope,f.confirmedBookingId,action('START',2))
  const other=await db.supplier.create({data:{company_id:scope.companyId,name:'Ausente QA',contact:'Ausente QA',party_type:'CUSTOMER'}})
  const source=await db.appointmentBooking.findUnique({where:{id:f.confirmedBookingId}})
  const missing=await db.appointmentBooking.create({data:{company_id:scope.companyId,branch_id:scope.branchId,session_id:f.groupSessionId,contact_id:other.id,status:'CONFIRMED',quantity:source.quantity,commercial_snapshot:source.commercial_snapshot,policy_snapshot:source.policy_snapshot,created_by:scope.userId}})
  await app.transitionSession(db,scope,f.groupSessionId,action('COMPLETE',1))
  assert.equal((await db.appointmentBooking.findUnique({where:{id:f.confirmedBookingId}})).status,'IN_SERVICE')
  assert.equal((await app.transitionBooking(db,scope,f.confirmedBookingId,action('COMPLETE',3))).status,'COMPLETED')
  assert.equal((await app.transitionBooking(db,scope,missing.id,action('NO_SHOW',1))).status,'NO_SHOW')
}))
test('guardar servicio y agenda es atómico: perfil inválido no deja producto huérfano ni altera unidad comercial',async()=>withAppointmentsTestDb(async({db,scope,fixtures:f})=>{
  const {withMocks,jsonResponse}=require('./helpers/reportHarness.cjs'),path=require('node:path')
  const product=await db.product.findUnique({where:{id:f.productId}}),before=await db.product.count()
  const profile={enabled:false,mode:'INDIVIDUAL',durationMinutes:0,beforeMinutes:0,afterMinutes:0,intervalMinutes:15,leadMinutes:0,horizonDays:60,cancellationHours:24,confirmation:'AUTOMATIC',capacity:1,requiresProvider:true,requiresResource:false,branchIds:[scope.branchId],providerIds:[],resourceIds:[],instructions:''}
  const req={companyId:scope.companyId,branchId:scope.branchId,userBranchIds:scope.branchIds,user:{sub:scope.userId,role:{name:'admin'},permissions:['appointments.view','appointments.configure']},body:{kind:'SERVICE',name:'No debe quedar huérfano',category_id:product.category_id,service_unit_label:'Hora',quantity_decimals:3,price:'150',schedule_profile:profile}}
  await withMocks({[require.resolve('../src/models/prisma')]:{prisma:db,prismaTransaction:db}},path.resolve(__dirname,'../src/modules/inventory/products.controller.js'),async controller=>{
    await assert.rejects(()=>controller.create(req,jsonResponse(),error=>{throw error}),{status:400})
    assert.equal(await db.product.count(),before)
    const res=jsonResponse();req.body.schedule_profile.durationMinutes=60
    await controller.create(req,res,error=>{throw error})
    assert.equal(res.statusCode,201)
    const created=await db.product.findUnique({where:{id:res.body.product.id},include:{service_schedule_profile:true}})
    assert.equal(created.service_unit_label,'Hora');assert.equal(created.quantity_decimals,3);assert.equal(created.service_schedule_profile.duration_minutes,60)
  })
}))
test('formulario ofrece horarios para crear grupo y mover sin bloquearse con su propia sesión',async()=>withAppointmentsTestDb(async context=>{
  await seedAgenda(context)
  const {db,scope,fixtures:f}=context
  const booking=await app.createBooking(db,scope,f.individualInput)
  const input={productId:f.productId,from:booking.startsAt,to:new Date(new Date(booking.startsAt).getTime()+86400000).toISOString()}
  const slots=await q.readMoveAvailability(db,scope,'booking',booking.id,input)
  assert.ok(slots.some(s=>s.startsAt===booking.startsAt))
  await assert.rejects(()=>q.readMoveAvailability(db,{...scope,branchId:f.secondBranchId},'booking',booking.id,input),{status:404})
  const group=await db.appointmentSession.findUnique({where:{id:f.groupSessionId}})
  const groupSlots=await q.readSessionAvailability(db,scope,{...input,productId:group.product_id})
  assert.ok(groupSlots.length>0);assert.ok(groupSlots.every(s=>s.sessionId===null))
  const contacts=await q.listContacts(db,scope,{q:'Cliente'})
  assert.ok(contacts.items.every(c=>Object.keys(c).sort().join(',')==='address,id,name'))
  assert.equal(await db.sale.count(),0)
  const other=await db.serviceProvider.create({data:{company_id:scope.companyId,name:'Ajeno al profesional',created_by:scope.userId}})
  await db.serviceProviderBranch.create({data:{company_id:scope.companyId,branch_id:scope.branchId,provider_id:other.id}})
  const own={...scope,isAdmin:false,permissions:['appointments.view']}
  const ownDirectory=await require('../src/modules/appointments/directory').listDirectory(db,own)
  assert.equal(ownDirectory.providers.length,1)
  assert.equal(ownDirectory.providers[0].employeeId,null);assert.equal(ownDirectory.providers[0].userId,null)
}))
test('ausencia nueva alerta sin cancelar; confirmación manual no ignora conflicto y expirado no revive',async()=>withAppointmentsTestDb(async context=>{
  await seedAgenda(context)
  const {db,scope,fixtures:f}=context
  await db.serviceScheduleProfile.update({where:{product_id:f.productId},data:{confirmation:'MANUAL'}})
  const booking=await app.createBooking(db,scope,f.individualInput)
  const employee=await db.employee.create({data:{company_id:scope.companyId,branch_id:scope.branchId,code:'QA-1',first_name:'Persona',last_name:'QA',hire_date:new Date('2020-01-01'),base_salary:'0'}})
  await db.serviceProvider.update({where:{id:f.providerId},data:{employee_id:employee.id}})
  const day=require('luxon').DateTime.fromISO(booking.startsAt).setZone(booking.timezone).toISODate()
  await db.attendance.create({data:{company_id:scope.companyId,branch_id:scope.branchId,employee_id:employee.id,work_date:new Date(day+'T00:00Z'),status:'VACACIONES'}})
  const loaded=await q.getBooking(db,scope,booking.id)
  assert.ok(loaded.conflicts.some(c=>/ausencia/i.test(c)));assert.equal(loaded.status,'PENDING')
  await assert.rejects(()=>app.transitionBooking(db,scope,booking.id,{action:'CONFIRM',expectedVersion:1,idempotencyKey:crypto.randomUUID(),reason:''}),{status:409,code:'SCHEDULE_CONFLICT'})
  await db.appointmentBooking.update({where:{id:booking.id},data:{expires_at:new Date(0)}})
  const expired=await app.transitionBooking(db,scope,booking.id,{action:'CONFIRM',expectedVersion:1,idempotencyKey:crypto.randomUUID(),reason:''})
  assert.equal(expired.status,'EXPIRED')
  await assert.rejects(()=>app.transitionBooking(db,scope,booking.id,{action:'CONFIRM',expectedVersion:2,idempotencyKey:crypto.randomUUID(),reason:''}),{status:409})
  assert.equal(await db.sale.count(),0)
}))
