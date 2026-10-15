const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto')
const {withCommercialAgendaTestDb}=require('./helpers/commercialAgendaFixture.cjs')
const E=require('../src/modules/appointments/engagements'),A=require('../src/modules/appointments/application')
test('the already deployed commercial index allows separate bookings but rejects exclusive activity duplicates',async()=>withCommercialAgendaTestDb(async({db,scope,fixtures:f})=>{
  const make=()=>E.createEngagement(db,scope,{contactId:f.contactId,lines:[{productId:f.groupProductId,quantity:'1'}],idempotencyKey:crypto.randomUUID()})
  const first=await make(),second=await make(),customer=await db.supplier.create({data:{company_id:scope.companyId,name:'Otro QA',contact:'QA',party_type:'CUSTOMER'}})
  const booking=await A.enrollBooking(db,scope,f.groupSessionId,{contactId:customer.id,quantity:'1',notes:'',idempotencyKey:crypto.randomUUID()})
  const base={company_id:scope.companyId,branch_id:scope.branchId,session_id:f.groupSessionId,session_type:'SCHEDULED_SERVICE',kind:'BOOKING',quantity:1,conditions_hash:'b'.repeat(64)}
  await db.appointmentEngagementSchedule.create({data:{...base,engagement_id:first.id,line_id:first.lines[0].id,booking_id:f.confirmedBookingId}})
  await db.appointmentEngagementSchedule.create({data:{...base,engagement_id:second.id,line_id:second.lines[0].id,booking_id:booking.id}})
  const activity=await require('../src/modules/appointments/activities').createActivity(db,scope,require('./helpers/agendaActivityFixture.cjs').activityInput(f))
  const exclusive={...base,session_id:activity.id,session_type:'ACTIVITY',kind:'ACTIVITY'}
  await db.appointmentEngagementSchedule.create({data:{...exclusive,engagement_id:first.id,line_id:first.lines[0].id}})
  await assert.rejects(()=>db.appointmentEngagementSchedule.create({data:{...exclusive,engagement_id:second.id,line_id:second.lines[0].id}}),{code:'P2002'})
  assert.equal(await db.appointmentEngagementSchedule.count(),3)
}))
