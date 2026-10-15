const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto')
const {withAppointmentsTestDb}=require('./helpers/appointmentsTestDb.cjs')
test('unified preserva perfil GROUP y permite requisitos independientes en SQL',async()=>withAppointmentsTestDb(async({db,scope,fixtures:f})=>{
  const id=crypto.randomUUID()
  await db.$executeRaw`INSERT INTO service_schedule_profiles (id,company_id,product_id,enabled,mode,duration_minutes,capacity,created_by,updated_at) VALUES (${id}::uuid,${scope.companyId}::uuid,${f.productId}::uuid,true,'GROUP',45,8,${scope.userId}::uuid,NOW())`
  const [before]=await db.$queryRaw`SELECT * FROM service_schedule_profiles WHERE id=${id}::uuid`
  const {applyUnifiedMigration}=require('./helpers/appointmentsTestDb.cjs')
  assert.equal(typeof applyUnifiedMigration,'function','Hay un ensayo explícito de la nueva delta')
  await applyUnifiedMigration(db)
  const [after]=await db.$queryRaw`SELECT p.* FROM service_schedule_profiles p WHERE id=${id}::uuid`
  for(const key of Object.keys(before)) assert.deepEqual(after[key],before[key],key)
  assert.equal(after.scheduling_style,'CLASS');assert.equal(after.duration_policy,'FIXED')
  await db.serviceScheduleProfile.update({where:{id},data:{requires_provider:false,requires_resource:false},select:{id:true}})
  await assert.rejects(()=>db.serviceScheduleProfile.update({where:{id},data:{scheduling_style:'WORK'},select:{id:true}}))
  await db.serviceScheduleProfile.update({where:{id},data:{scheduling_style:'WORK',mode:'INDIVIDUAL',capacity:1,duration_minutes:2880},select:{id:true}})
  await assert.rejects(()=>db.serviceScheduleProfile.update({where:{id},data:{duration_minutes:44641},select:{id:true}}))
},{version:'flexible'}))
