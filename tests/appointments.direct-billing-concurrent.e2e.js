const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto')
const {withCommercialAgendaTestDb}=require('./helpers/commercialAgendaFixture.cjs')
const A=require('../src/modules/appointments/application'),B=require('../src/modules/appointments/billingSources')
const key=()=>crypto.randomUUID()
test('concurrent preparation of one booking creates one engagement and rejects key reuse with other input',async()=>withCommercialAgendaTestDb(async({db,scope,fixtures:f})=>{
  const booking=await A.createBooking(db,scope,f.individualInput),p=await B.previewBillingSource(db,scope,'bookings',booking.id,{})
  const input={expectedVersion:p.origin.version,reviewHash:p.reviewHash,idempotencyKey:key()}
  const [one,two]=await Promise.all([B.prepareBillingSource(db,scope,'bookings',booking.id,input),B.prepareBillingSource(db,scope,'bookings',booking.id,{...input,idempotencyKey:key()})])
  assert.equal(one.id,two.id);assert.equal(await db.appointmentEngagement.count(),1);assert.equal(await db.appointmentEngagementSchedule.count(),1)
  await assert.rejects(B.prepareBillingSource(db,scope,'bookings',booking.id,{...input,expectedVersion:input.expectedVersion+1}),{code:'IDEMPOTENCY_CONFLICT'})
  await db.appointmentEngagementSchedule.updateMany({data:{state:'RELEASED'}})
  assert.equal((await B.prepareBillingSource(db,scope,'bookings',booking.id,{...input,idempotencyKey:key()})).id,one.id)
}))
test('stale booking version makes no partial financial records',async()=>withCommercialAgendaTestDb(async({db,scope,fixtures:f})=>{
  const booking=await A.createBooking(db,scope,f.individualInput),p=await B.previewBillingSource(db,scope,'bookings',booking.id,{})
  await db.appointmentBooking.update({where:{id:booking.id},data:{version:{increment:1}}})
  await assert.rejects(B.prepareBillingSource(db,scope,'bookings',booking.id,{expectedVersion:p.origin.version,reviewHash:p.reviewHash,idempotencyKey:key()}),{status:409})
  assert.equal(await db.appointmentEngagement.count(),0);assert.equal(await db.appointmentEngagementSchedule.count(),0)
}))
