const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto')
const {withCommercialAgendaTestDb}=require('./helpers/commercialAgendaFixture.cjs')
let commands={}
try{commands=require('../src/modules/appointments/engagements')}catch(e){if(e.code!=='MODULE_NOT_FOUND')throw e}
test('one accepted quote has one engagement across distinct retries and freezes all commercial lines',async()=>withCommercialAgendaTestDb(async({db,scope,fixtures:f})=>{
  assert.equal(typeof commands.createEngagement,'function')
  const first=await commands.createEngagement(db,scope,{quoteId:f.quoteId,idempotencyKey:crypto.randomUUID()})
  const second=await commands.createEngagement(db,scope,{quoteId:f.quoteId,idempotencyKey:crypto.randomUUID()})
  assert.equal(first.id,second.id);assert.equal(await db.appointmentEngagement.count(),1)
  assert.equal(first.money.agreedTotal,'175.00');assert.equal(first.lines.length,3)
  assert.equal(first.lines[0].unitPrice,'100.00');assert.equal(first.lines[1].unitPrice,'50.00')
  assert.equal(first.operationalState,'UNSCHEDULED')
  const visible=await commands.getEngagement(db,{...scope,isAdmin:false,permissions:['appointments.view']},first.id)
  assert.equal(Object.hasOwn(visible,'money'),false);assert.equal(Object.hasOwn(visible.lines[0],'unitPrice'),false)
  await assert.rejects(()=>commands.getEngagement(db,{...scope,branchId:f.secondBranchId},first.id),{status:404})
}))
test('batch conflicts roll back earlier lines, and a partial batch requires explicit confirmation',async()=>withCommercialAgendaTestDb(async({db,scope,fixtures:f})=>{
  const engagement=await commands.createEngagement(db,scope,{quoteId:f.quoteId,idempotencyKey:crypto.randomUUID()})
  const [appointment,work]=engagement.lines
  const first={lineId:appointment.id,quantity:'1',startsAt:f.individualInput.startsAt,timezone:'America/Guatemala',providerIds:[f.providerId],resourceIds:[],venue:{kind:'BRANCH'},acknowledgedConditionsVersion:appointment.conditionsVersion}
  const second={...first,lineId:work.id,organizerId:f.userId,acknowledgedConditionsVersion:work.conditionsVersion}
  const input={expectedVersion:engagement.version,idempotencyKey:crypto.randomUUID(),partial:false,programs:[first,second]}
  await assert.rejects(()=>commands.programEngagement(db,scope,engagement.id,input),error=>{
    assert.equal(typeof error.fields?.[`line-${work.id}`],'string')
    assert.match(error.fields[`line-${work.id}`],/Show QA/)
    return true
  })
  assert.equal(await db.appointmentEngagementSchedule.count(),0)
  assert.equal(await db.appointmentBooking.count(),1,'only preexisting fixture survives')
  await assert.rejects(()=>commands.programEngagement(db,scope,engagement.id,{...input,programs:[first]}),{code:'PARTIAL_CONFIRMATION_REQUIRED'})
  assert.equal(await db.appointmentEngagementSchedule.count(),0)
  const partial=await commands.programEngagement(db,scope,engagement.id,{...input,partial:true,programs:[first]})
  assert.equal(partial.operationalState,'PARTIALLY_SCHEDULED')
  await assert.rejects(()=>commands.programEngagement(db,scope,engagement.id,{...input,idempotencyKey:crypto.randomUUID(),partial:true,expectedVersion:partial.version,programs:[first]}),{code:'OVERBOOKED_QUANTITY'})
}))
test('changed or historical conditions require a current acknowledgement; unconfigured services retain the draft',async()=>withCommercialAgendaTestDb(async({db,scope,fixtures:f})=>{
  const engagement=await commands.createEngagement(db,scope,{quoteId:f.quoteId,idempotencyKey:crypto.randomUUID()})
  const line=engagement.lines[0]
  await db.serviceScheduleProfile.update({where:{product_id:f.productId},data:{public_instructions:'Nueva condición',version:{increment:1}}})
  const program={lineId:line.id,quantity:'1',startsAt:f.individualInput.startsAt,timezone:'America/Guatemala',providerIds:[f.providerId],acknowledgedConditionsVersion:line.conditionsVersion}
  const input={expectedVersion:engagement.version,idempotencyKey:crypto.randomUUID(),partial:true,programs:[program]}
  await assert.rejects(()=>commands.programEngagement(db,scope,engagement.id,input),{code:'CONDITIONS_CHANGED'})
  const current=await commands.getEngagement(db,scope,engagement.id)
  assert.equal(current.lines[0].conditionsChanged,true)
  assert.notEqual(current.lines[0].conditionsVersion,line.conditionsVersion)
  assert.equal(current.lines[0].offeredConditions.publicInstructions,'')
  await db.serviceScheduleProfile.update({where:{product_id:f.productId},data:{enabled:false}})
  await assert.rejects(()=>commands.programEngagement(db,scope,engagement.id,{...input,programs:[{...program,acknowledgedConditionsVersion:current.lines[0].conditionsVersion}]}),{code:'SERVICE_UNAVAILABLE'})
  assert.equal(await db.appointmentEngagementSchedule.count(),0)
}))
test('a private class sells commercial units without fabricating participants or charging each enrollment',async()=>withCommercialAgendaTestDb(async({db,scope,fixtures:f})=>{
  const engagement=await commands.createEngagement(db,scope,{contactId:f.contactId,lines:[{productId:f.groupProductId,quantity:'3'}],idempotencyKey:crypto.randomUUID()})
  const line=engagement.lines[0]
  const programmed=await commands.programEngagement(db,scope,engagement.id,{expectedVersion:engagement.version,partial:false,idempotencyKey:crypto.randomUUID(),programs:[{
    lineId:line.id,quantity:'3',capacity:2,startsAt:f.individualInput.startsAt,timezone:'America/Guatemala',providerIds:[f.providerId],resourceIds:[f.resourceId],acknowledgedConditionsVersion:line.conditionsVersion
  }]})
  assert.equal(programmed.money.agreedTotal,'225.00')
  const sessionId=programmed.lines[0].schedules[0].sessionId
  assert.equal(await db.appointmentBooking.count({where:{session_id:sessionId}}),0)
  const {enrollBooking}=require('../src/modules/appointments/application')
  const enrolled=await enrollBooking(db,scope,sessionId,{contactId:f.contactId,quantity:'1',idempotencyKey:crypto.randomUUID()})
  assert.equal(enrolled.includedInEngagement,true)
  assert.equal(enrolled.engagementId,engagement.id)
  assert.equal(enrolled.commercial,null)
  assert.equal((await commands.getEngagement(db,scope,engagement.id)).money.agreedTotal,'225.00')
}))
test('disabled quotation module and catalog overflow fail before creating a commercial engagement',async()=>withCommercialAgendaTestDb(async({db,scope,fixtures:f})=>{
  await db.companyModule.create({data:{company_id:scope.companyId,module_code:'quotes',status:'DISABLED'}})
  await assert.rejects(()=>commands.createEngagement(db,scope,{quoteId:f.quoteId,idempotencyKey:crypto.randomUUID()}),{code:'MODULE_DISABLED'})
  await db.product.update({where:{id:f.productId},data:{price:'9999999999.99'}})
  await assert.rejects(()=>commands.createEngagement(db,scope,{contactId:f.contactId,lines:[{productId:f.productId,quantity:'2'}],idempotencyKey:crypto.randomUUID()}),{code:'INVALID_MONEY'})
  assert.equal(await db.appointmentEngagement.count(),0)
}))
test('an existing order is linked rather than recreated and the frozen source remains JSON data',async()=>withCommercialAgendaTestDb(async({db,scope,fixtures:f})=>{
  const order=await db.commercialDocument.create({data:{branch_id:scope.branchId,doc_type:'ORDER',status:'DRAFT',total:175,converted_from_id:f.quoteId}})
  const engagement=await commands.createEngagement(db,scope,{quoteId:f.quoteId,idempotencyKey:crypto.randomUUID()})
  assert.equal(engagement.orderId,order.id)
  const row=await db.appointmentEngagement.findUnique({where:{id:engagement.id}})
  assert.equal(row.commercial_snapshot.orders[0].id,order.id)
  assert.equal(await db.commercialDocument.count({where:{doc_type:'ORDER'}}),1)
}))
test('a batch creates appointment and external WORK without changing agreed amounts or scheduling goods',async()=>withCommercialAgendaTestDb(async({db,scope,fixtures:f})=>{
  assert.equal(typeof commands.programEngagement,'function')
  const engagement=await commands.createEngagement(db,scope,{quoteId:f.quoteId,idempotencyKey:crypto.randomUUID()})
  const appointment=engagement.lines.find(l=>l.productId===f.productId),work=engagement.lines.find(l=>l.productId===f.workProductId)
  const start=f.individualInput.startsAt,workStart=new Date(new Date(start).getTime()+5400000).toISOString()
  const result=await commands.programEngagement(db,scope,engagement.id,{expectedVersion:engagement.version,idempotencyKey:crypto.randomUUID(),partial:false,programs:[
    {lineId:appointment.id,quantity:'1',startsAt:start,timezone:'America/Guatemala',providerIds:[f.providerId],resourceIds:[],venue:{kind:'BRANCH'},acknowledgedConditionsVersion:appointment.conditionsVersion},
    {lineId:work.id,quantity:'1',startsAt:workStart,endsAt:new Date(new Date(workStart).getTime()+3600000).toISOString(),timezone:'America/Guatemala',organizerId:f.userId,providerIds:[],resourceIds:[],venue:{kind:'EVENT_VENUE',name:'Salón QA',address:'Dirección QA'},acknowledgedConditionsVersion:work.conditionsVersion}
  ]})
  assert.equal(result.operationalState,'SCHEDULED');assert.equal(result.money.agreedTotal,'175.00')
  const scheduled=await db.appointmentEngagementSchedule.findMany({where:{engagement_id:engagement.id},include:{booking:true,session:true}})
  assert.equal(scheduled.length,2)
  assert.equal(scheduled.find(s=>s.kind==='BOOKING').booking.commercial_snapshot.unitPrice,'100.00')
  assert.equal(scheduled.find(s=>s.kind==='ACTIVITY').session.venue.kind,'EVENT_VENUE')
  assert.equal(await db.sale.count(),1,'only the unrelated debt fixture exists')
}))
