const test=require('node:test'), assert=require('node:assert/strict'), crypto=require('node:crypto')
const {withAppointmentsTestDb}=require('./helpers/appointmentsTestDb.cjs')

test('base flexible admite actividad sin producto y rechaza formas o inscripciones incorrectas',async()=>
  withAppointmentsTestDb(async({db,scope,fixtures:f,schema})=>{
    const columns=await db.$queryRaw`SELECT column_name FROM information_schema.columns WHERE table_schema=${schema} AND table_name='appointment_sessions'`
    assert.ok(columns.some(c=>c.column_name==='record_type'),'La migración flexible agrega el tipo de bloque')
    const data={company_id:scope.companyId,branch_id:scope.branchId,record_type:'ACTIVITY',purpose:'EVENT',title:'Show QA',
      organizer_id:f.userId,mode:'INDIVIDUAL',starts_at:new Date('2030-01-01T18:00Z'),ends_at:new Date('2030-01-01T20:00Z'),
      occupied_from:new Date('2030-01-01T16:30Z'),occupied_until:new Date('2030-01-01T21:00Z'),
      outbound_minutes:30,setup_minutes:60,teardown_minutes:30,return_minutes:30,timezone:'America/Guatemala',
      capacity:1,policy_snapshot:{},created_by:f.userId}
    const row=await db.appointmentSession.create({data})
    assert.equal(row.product_id,null)
    for(const patch of [{record_type:'SCHEDULED_SERVICE'},{organizer_id:null},{title:null},{title:' '},{purpose:'CLASS'},
      {capacity:80},{outbound_minutes:-1},{setup_minutes:1441}])
      await assert.rejects(()=>db.appointmentSession.create({data:{...data,...patch}}))
    const participant={company_id:scope.companyId,session_id:row.id,kind:'USER',user_id:f.userId}
    await db.appointmentParticipant.create({data:participant})
    await assert.rejects(()=>db.appointmentParticipant.create({data:participant}))
    await assert.rejects(()=>db.appointmentParticipant.create({data:{...participant,user_id:null}}))
    await assert.rejects(()=>db.appointmentParticipant.create({data:{...participant,kind:'GUEST',name:'QA'}}))
    const foreign=await db.company.create({data:{name:'Ajena QA',code:crypto.randomUUID().slice(0,16)}})
    await assert.rejects(()=>db.appointmentParticipant.create({data:{...participant,company_id:foreign.id}}))
    const booking={company_id:scope.companyId,branch_id:scope.branchId,session_id:row.id,contact_id:f.contactId,
      status:'CONFIRMED',quantity:'1',commercial_snapshot:{},policy_snapshot:{},created_by:f.userId}
    await assert.rejects(()=>db.appointmentBooking.create({data:booking}))
    await assert.rejects(()=>db.appointmentWaitlist.create({data:{company_id:scope.companyId,session_id:row.id,contact_id:f.contactId,created_by:f.userId}}))
    await db.userBranch.deleteMany({where:{user_id:f.userId}})
    await db.userCompany.deleteMany({where:{user_id:f.userId}})
    assert.equal((await db.appointmentSession.findUnique({where:{id:row.id}})).organizer_id,f.userId)
    const fks=await db.$queryRaw`SELECT p.nspname AS parent_schema FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace JOIN pg_class r ON r.oid=c.confrelid JOIN pg_namespace p ON p.oid=r.relnamespace WHERE c.contype='f' AND n.nspname=${schema}`
    assert.ok(fks.every(r=>r.parent_schema===schema))
  }))

test('delta conserva sesiones, inscripciones y espera existentes del core',async()=>
  withAppointmentsTestDb(async({db,scope,fixtures:f})=>{
    const id=crypto.randomUUID(), bookingId=crypto.randomUUID(), waitingId=crypto.randomUUID()
    await db.$executeRaw`INSERT INTO appointment_sessions (id,company_id,branch_id,product_id,mode,starts_at,ends_at,occupied_from,occupied_until,timezone,capacity,policy_snapshot,created_by,updated_at,version) VALUES (${id}::uuid,${scope.companyId}::uuid,${scope.branchId}::uuid,${f.productId}::uuid,'GROUP','2030-01-01T18:00Z','2030-01-01T20:00Z','2030-01-01T18:00Z','2030-01-01T20:00Z','America/Guatemala',5,'{"durationMinutes":120}'::jsonb,${f.userId}::uuid,now(),3)`
    await db.$executeRaw`INSERT INTO appointment_bookings (id,company_id,branch_id,session_id,contact_id,status,quantity,commercial_snapshot,policy_snapshot,created_by,updated_at) VALUES (${bookingId}::uuid,${scope.companyId}::uuid,${scope.branchId}::uuid,${id}::uuid,${f.contactId}::uuid,'CONFIRMED',1,'{"price":"150"}'::jsonb,'{}'::jsonb,${f.userId}::uuid,now())`
    await db.$executeRaw`INSERT INTO appointment_waitlist (id,company_id,session_id,contact_id,created_by,updated_at) VALUES (${waitingId}::uuid,${scope.companyId}::uuid,${id}::uuid,${f.contactId}::uuid,${f.userId}::uuid,now())`
    const [before]=await db.$queryRaw`SELECT * FROM appointment_sessions WHERE id=${id}::uuid`
    const [beforeBooking]=await db.$queryRaw`SELECT * FROM appointment_bookings WHERE id=${bookingId}::uuid`
    const [beforeWaiting]=await db.$queryRaw`SELECT * FROM appointment_waitlist WHERE id=${waitingId}::uuid`
    const {applyFlexibleMigration}=require('./helpers/appointmentsTestDb.cjs')
    await applyFlexibleMigration(db)
    const [after]=await db.$queryRaw`SELECT s.* FROM appointment_sessions s WHERE id=${id}::uuid`
    for(const key of Object.keys(before)) assert.deepEqual(after[key],before[key],key)
    assert.equal(after.record_type,'SCHEDULED_SERVICE')
    const afterBooking=await db.appointmentBooking.findUnique({where:{id:bookingId}})
    const afterWaiting=await db.appointmentWaitlist.findUnique({where:{id:waitingId}})
    for(const key of Object.keys(beforeBooking)) assert.deepEqual(afterBooking[key],beforeBooking[key],key)
    for(const key of Object.keys(beforeWaiting)) assert.deepEqual(afterWaiting[key],beforeWaiting[key],key)
  },{version:'core'}))
