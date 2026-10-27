// Opt-in acceptance: exclusively a disposable, loopback PostgreSQL database.
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto')
const {paymentTermsTestUrl,paymentTermsClient}=require('./helpers/eventPaymentTermsTestDb.cjs')
const target=paymentTermsTestUrl(),generated=paymentTermsClient(target,{namespace:true})
require.cache[require.resolve('@prisma/client')]={exports:generated}
process.env.DATABASE_URL=target;process.env.DIRECT_URL=target
process.env.JWT_SECRET='synthetic-payment-policy-acceptance-only-not-a-real-secret'
const {createEngagement,programEngagement,getEngagement}=require('../src/modules/appointments/engagements')
const {withAgendaTransaction}=require('../src/modules/appointments/application')
const {collectEngagementPayment}=require('../src/modules/appointments/engagementPayments')
const {loadPaymentEngagement}=require('../src/modules/appointments/engagementPaymentReference')
const {loadEngagementPaymentState,assertEngagementPaymentAction:guard}=require('../src/modules/appointments/engagementPaymentPolicy')
const {lockCustomer,receiveEngagementPayment,resolveReservedFunds}=require('../src/modules/receivables')

test('payment conditions use current allocations and atomic schedule reviews across two PostgreSQL connections',async t=>{
 const db=new generated.PrismaClient({datasources:{db:{url:target}}}),other=new generated.PrismaClient({datasources:{db:{url:target}}})
 t.after(()=>Promise.all([db.$disconnect(),other.$disconnect()]))
 assert.equal(await require('../src/services/eventPaymentTermsStorage').eventPaymentStorageReady(db),true,'apply the migration to the isolated test database first')
 const company=await db.company.create({data:{name:'Synthetic 2C acceptance',code:randomUUID().slice(0,12)}})
 const branch=await db.branch.create({data:{company_id:company.id,name:'Synthetic branch',code:'PC'}})
 const role=await db.role.create({data:{name:'Synthetic '+randomUUID()}})
 const actor=await db.user.create({data:{name:'Synthetic operator',email:randomUUID()+'@invalid.test',password:'synthetic-only',role_id:role.id}})
 await db.userCompany.create({data:{company_id:company.id,user_id:actor.id}});await db.userBranch.create({data:{branch_id:branch.id,user_id:actor.id}})
 for(const code of ['appointments','sales','receivables','inventory','contacts'])await db.companyModule.create({data:{company_id:company.id,module_code:code,status:'ACTIVE'}})
 await db.companyModule.create({data:{company_id:company.id,module_code:'accounting',status:'DISABLED'}})
 await db.systemSetting.create({data:{company_id:company.id,key:'inventory_services_enabled',value:'true',type:'boolean'}})
 const scope={companyId:company.id,branchId:branch.id,branchIds:[branch.id],userId:actor.id,isAdmin:true,permissions:[]}
 const customer=await db.supplier.create({data:{company_id:company.id,name:'Synthetic customer',contact:'Synthetic only',party_type:'CUSTOMER',credit_limit:100000}})
 const category=await db.productCategory.create({data:{company_id:company.id,name:'Synthetic services'}}),status=await db.stockStatus.create({data:{name:'Synthetic '+randomUUID()}})
 const product=await db.product.create({data:{company_id:company.id,name:'Synthetic event',kind:'SERVICE',service_unit_label:'evento',price:'100',cost:'0',category_id:category.id,status_id:status.id}})
 const method=await db.paymentMethod.create({data:{company_id:company.id,name:'Transferencia QA 2C',settlement_kind:'BANK'}})
 const credit=await db.paymentMethod.create({data:{company_id:company.id,name:'Crédito QA 2C',is_credit:true,settlement_kind:'CREDIT'}})
 for(const payment_method_id of [method.id,credit.id])await db.companyPaymentMethod.create({data:{company_id:company.id,payment_method_id,enabled:true}})
 await db.saleStatus.upsert({where:{name:'Completada'},create:{name:'Completada'},update:{}})
 await db.saleStatus.upsert({where:{name:'Cancelada'},create:{name:'Cancelada'},update:{}})
 await withAgendaTransaction(db,company.id,async tx=>{
  await require('../src/modules/appointments/calendars').saveCalendar(tx,scope,'branch',branch.id,{timezone:'UTC',expectedVersion:0,weekly:Array.from({length:7},(_,i)=>({weekday:i+1,from:'00:00',to:'24:00'})),exceptions:[]})
  await require('../src/modules/appointments/profiles').saveServiceProfile(tx,scope,product.id,{enabled:true,schedulingStyle:'WORK',mode:'INDIVIDUAL',durationPolicy:'EDITABLE',completionPolicy:'MANUAL',durationMinutes:60,beforeMinutes:0,afterMinutes:0,intervalMinutes:15,leadMinutes:0,horizonDays:60,cancellationHours:24,confirmation:'AUTOMATIC',capacity:1,requiresProvider:false,requiresResource:false,branchIds:[branch.id],providerIds:[],resourceIds:[],allowedVenueKinds:['BRANCH'],instructions:'',expectedVersion:0})
 })
 const base=require('luxon').DateTime.utc().plus({days:2}).startOf('day').set({hour:16}).toISO(),at=(day,minutes=0)=>new Date(Date.parse(base)+day*86400000+minutes*60000).toISOString()
 const terms=day=>({schemaVersion:1,depositPercent:'25',balanceDaysBefore:0,referenceStartsAt:at(day),referenceTimezone:'UTC'})
 const make=(day,quantity='1')=>createEngagement(db,scope,{contactId:customer.id,lines:[{productId:product.id,quantity}],eventPaymentTerms:terms(day),idempotencyKey:randomUUID()})
 const payment=(e,amount)=>collectEngagementPayment(db,scope,e.id,{amount,paymentMethodId:method.id,currencyCode:'GTQ',paidAt:new Date().toISOString(),expectedVersion:e.version,idempotencyKey:randomUUID()})
 const program=(e,day,quantity='1')=>programEngagement(db,scope,e.id,{expectedVersion:e.version,partial:false,idempotencyKey:randomUUID(),programs:[{lineId:e.lines[0].id,quantity,startsAt:at(day),endsAt:at(day,60),timezone:'UTC',providerIds:[],resourceIds:[],organizerId:actor.id,venue:{kind:'BRANCH'},acknowledgedConditionsVersion:e.lines[0].conditionsVersion}]})
 const state=async(e,now=new Date())=>loadEngagementPaymentState(db,scope,await loadPaymentEngagement(db,scope,e.id),{now})
 const action=(client,e,action='START',extras={})=>client.$transaction(tx=>guard(tx,scope,{sessionId:e.lines[0].schedules[0].sessionId,action,now:new Date(Date.parse(e.lines[0].schedules[0].startsAt)-60000),idempotencyKey:randomUUID(),...extras}),{timeout:15000})
 async function serializedFunds(e,write,check){
  let ready,release;const held=new Promise(resolve=>ready=resolve),gate=new Promise(resolve=>release=resolve)
  const first=db.$transaction(async tx=>{await lockCustomer(tx,customer.id);await write(tx);ready();await gate},{timeout:15000})
  // Do not leave a failed fixture holding locks until the transaction timeout.
  let firstError;first.catch(error=>{firstError=error;ready()})
  await held;if(firstError)throw firstError
  let pid,finished=false
  const second=other.$transaction(async tx=>{pid=(await tx.$queryRaw`SELECT pg_backend_pid() AS pid`)[0].pid;return check(tx)},{timeout:15000}).finally(()=>{finished=true})
  second.catch(()=>{})
  try{
   let waiting=false
   for(let i=0;i<200&&!finished;i++){
    if(pid&&(await db.$queryRaw`SELECT wait_event_type FROM pg_stat_activity WHERE pid=${pid}`)[0]?.wait_event_type==='Lock'){waiting=true;break}
    await new Promise(resolve=>setTimeout(resolve,5))
   }
   assert.equal(waiting,true,'second connection actually waits on the held customer lock')
  }finally{release()}
  await first;return second
 }
 await t.test('a simultaneous receipt is re-read after the customer lock, and no free credit confirms a different agreement',async()=>{
  let e=await program(await make(0),0)
  assert.equal((await state(e)).confirmation,'PENDING_DEPOSIT')
  const stored=await loadPaymentEngagement(db,scope,e.id)
  await serializedFunds(e,async tx=>{
   await receiveEngagementPayment(tx,scope,stored,{amount:'40.00',paymentMethodId:method.id,currencyCode:'GTQ',paidAt:new Date().toISOString(),idempotencyKey:randomUUID(),reference:'Synthetic receipt'})
   await tx.appointmentEngagement.update({where:{id:e.id},data:{version:{increment:1}}})
  },tx=>guard(tx,scope,{sessionId:e.lines[0].schedules[0].sessionId,action:'START',now:new Date(Date.parse(at(0))-60000),idempotencyKey:randomUUID()}))
  assert.equal((await state(e)).paid,'40.00')
  const another=await program(await make(1),1)
  assert.equal((await state(another)).paid,'0.00');await assert.rejects(()=>action(other,another),{code:'EVENT_PAYMENT_CONDITIONS_REQUIRED'})
 })
 await t.test('release versus completion cannot authorize from a stale deposit; release is not subtracted twice',async()=>{
  let e=await make(2);e=(await payment(e,'40.00')).engagement;e=await program(e,2)
  const receipt=await db.customerPayment.findFirst({where:{commitments:{some:{engagement_id:e.id}}}}),stored=await loadPaymentEngagement(db,scope,e.id)
  await assert.rejects(()=>serializedFunds(e,tx=>resolveReservedFunds(tx,scope,stored,{action:'RELEASE',receiptId:receipt.id,amount:'30.00',reason:'Synthetic release',idempotencyKey:randomUUID()}),tx=>guard(tx,scope,{sessionId:e.lines[0].schedules[0].sessionId,action:'COMPLETE',now:new Date(Date.parse(at(2))-60000),idempotencyKey:randomUUID()})),{code:'EVENT_PAYMENT_CONDITIONS_REQUIRED'})
  const next=await state(e);assert.equal(next.paid,'10.00');assert.equal(next.depositMissing,'15.00');assert.equal(next.remaining,'90.00')
 })
 await t.test('commitment to sale application remains one payment and a corrected sale demands review',async()=>{
  let e=await make(3);e=(await payment(e,'40.00')).engagement;e=await program(e,3)
  assert.equal((await state(e)).paid,'40.00')
  e=await require('../src/modules/appointments/engagementSales').issueEngagementSale(db,scope,e.id,{paymentCondition:'CREDIT',dueDate:at(20).slice(0,10),expectedVersion:e.version,idempotencyKey:randomUUID()})
  assert.equal((await state(e)).paid,'40.00');assert.equal((await state(e)).remaining,'60.00')
  await db.sale.update({where:{id:e.saleId},data:{adjusted_total:'90.00'}})
  assert.equal((await state(e)).confirmation,'REVIEW_REQUIRED')
 })
 await t.test('money or action changes invalidate an overdue exception and a revoked permission cannot reuse it',async()=>{
  let e=await make(4);e=(await payment(e,'40.00')).engagement;e=await program(e,4)
  const now=new Date(Date.parse(at(4))+1),request={sessionId:e.lines[0].schedules[0].sessionId,action:'START',now,idempotencyKey:randomUUID()}
  let blocked;try{await other.$transaction(tx=>guard(tx,scope,request))}catch(error){blocked=error}
  assert.equal(blocked.code,'EVENT_PAYMENT_CONDITIONS_REQUIRED');assert.equal(blocked.fields.paymentPolicyCanOverride,'true')
  const exception={reason:'Synthetic authorization',reviewHash:blocked.fields.paymentPolicyReviewHash}
  await assert.rejects(()=>other.$transaction(tx=>guard(tx,scope,{...request,action:'COMPLETE',exception})),{code:'PAYMENT_POLICY_REVIEW_CHANGED'})
  const limited={...scope,isAdmin:false,permissions:['appointments.view','appointments.view_team','appointments.attend','receivables.view']}
  await assert.rejects(()=>other.$transaction(tx=>guard(tx,limited,{...request,exception})),{status:403})
  e=(await payment(e,'5.00')).engagement
  await assert.rejects(()=>other.$transaction(tx=>guard(tx,scope,{...request,exception})),{code:'PAYMENT_POLICY_REVIEW_CHANGED'})
  const operational=await getEngagement(db,{...limited,permissions:['appointments.view','appointments.view_team']},e.id)
  assert.equal(operational.paymentPolicy.paid,undefined);assert.equal(operational.paymentPolicy.reviewHash,undefined);assert.equal(operational.eventPaymentTerms,undefined)
 })
 await t.test('a real operational transition records one scoped exception, cannot replay it for completion, and cancellation never refunds',async()=>{
  let e=await make(10);e=(await payment(e,'40.00')).engagement;e=await program(e,10)
  const activities=require('../src/modules/appointments/activities'),id=e.lines[0].schedules[0].sessionId
  // Synthetic historical fixture, not an application edit: keep its actual reference and occupied range coherent.
  const startsAt=new Date(Date.now()-7200000),endsAt=new Date(Date.now()-3600000)
  await db.appointmentSession.update({where:{id},data:{starts_at:startsAt,ends_at:endsAt,occupied_from:startsAt,occupied_until:endsAt}})
  await db.appointmentEngagement.update({where:{id:e.id},data:{event_payment_reference:{startsAt:startsAt.toISOString(),timezone:'UTC'}}})
  const raw={action:'START',expectedVersion:1,idempotencyKey:randomUUID()}
  let denied;try{await activities.transitionActivity(db,scope,id,raw)}catch(error){denied=error}
  assert.equal(denied.code,'EVENT_PAYMENT_CONDITIONS_REQUIRED')
  const input={...raw,exception:{reason:'Synthetic single-action credit authorization',reviewHash:denied.fields.paymentPolicyReviewHash}}
  const started=await activities.transitionActivity(db,scope,id,input)
  await activities.transitionActivity(other,scope,id,input)
  assert.equal(started.status,'IN_PROGRESS');assert.equal(await db.appointmentEngagementHistory.count({where:{engagement_id:e.id,action:'PAYMENT_POLICY_EXCEPTION'}}),1)
  await assert.rejects(()=>activities.transitionActivity(other,scope,id,{...input,action:'COMPLETE',expectedVersion:started.version,idempotencyKey:randomUUID()}),{code:'PAYMENT_POLICY_REVIEW_CHANGED'})
  await activities.transitionActivity(db,scope,id,{action:'CANCEL',expectedVersion:started.version,reason:'Synthetic cancellation',idempotencyKey:randomUUID()})
  assert.equal(await db.customerPaymentRefund.count({where:{engagement_id:e.id}}),0)
  assert.equal((await state(e)).paid,'40.00')
 })
 await t.test('a new first service requires explicit review, rolls back on refusal and revalidates after another receipt',async()=>{
  let e=await make(6);e=(await payment(e,'40.00')).engagement;e=await program(e,6)
  const activities=require('../src/modules/appointments/activities'),id=e.lines[0].schedules[0].sessionId,original=await activities.getActivity(db,scope,id)
  const row=await db.appointmentSession.findUnique({where:{id}})
  const edit={purpose:row.purpose,title:row.title,startsAt:at(5),endsAt:at(5,60),timezone:'UTC',organizerId:actor.id,userIds:[],providerIds:[],resourceIds:[],guests:[],productId:product.id,serviceScheduling:'CONFIGURED',venue:{kind:'BRANCH'},outboundMinutes:0,setupMinutes:0,teardownMinutes:0,returnMinutes:0,notes:'Synthetic',expectedVersion:original.version,reason:'Synthetic earlier schedule',idempotencyKey:randomUUID()}
  let error;try{await activities.updateActivity(db,scope,id,edit)}catch(e){error=e}
  assert.equal(error.code,'PAYMENT_REFERENCE_REVIEW_REQUIRED')
  assert.equal((await db.appointmentSession.findUnique({where:{id}})).starts_at.toISOString(),at(6))
  const before=await db.appointmentEngagementHistory.count({where:{engagement_id:e.id,action:'PAYMENT_REFERENCE_REVIEWED'}})
  e=(await payment(e,'5.00')).engagement
  let changed;try{await activities.updateActivity(other,scope,id,{...edit,acknowledgedPaymentReviewHash:error.fields.acknowledgedPaymentReviewHash})}catch(e){changed=e}
  assert.equal(changed.code,'PAYMENT_REFERENCE_REVIEW_REQUIRED');assert.notEqual(changed.fields.acknowledgedPaymentReviewHash,error.fields.acknowledgedPaymentReviewHash)
  const reviewed={...edit,acknowledgedPaymentReviewHash:changed.fields.acknowledgedPaymentReviewHash}
  await activities.updateActivity(db,scope,id,reviewed);await activities.updateActivity(other,scope,id,reviewed)
  assert.equal((await state(e)).reference.startsAt,at(5))
  assert.equal(await db.appointmentEngagementHistory.count({where:{engagement_id:e.id,action:'PAYMENT_REFERENCE_REVIEWED'}}),before+1)
 })
 await t.test('a shared class checks only the selected enrollment, never another customer or the entire public session',async()=>{
  const app=require('../src/modules/appointments/application'),profiles=require('../src/modules/appointments/profiles')
  const classProduct=await db.product.create({data:{company_id:company.id,name:'Synthetic class',kind:'SERVICE',service_unit_label:'sesión',price:'100',cost:'0',category_id:category.id,status_id:status.id}})
  const profile=profiles.presentProfile(await db.serviceScheduleProfile.findUnique({where:{product_id:product.id},include:{branches:true,providers:true,resources:true}})).profile
  await withAgendaTransaction(db,company.id,tx=>profiles.saveServiceProfile(tx,scope,classProduct.id,{...profile,schedulingStyle:'CLASS',mode:'GROUP',durationPolicy:'FIXED',capacity:10,expectedVersion:0}))
  const another=await db.supplier.create({data:{company_id:company.id,name:'Synthetic second customer',contact:'Synthetic',party_type:'CUSTOMER'}})
  const agreements=[]
  for(const contactId of [customer.id,another.id])agreements.push(await createEngagement(db,scope,{contactId,lines:[{productId:classProduct.id,quantity:'1'}],eventPaymentTerms:terms(13),idempotencyKey:randomUUID()}))
  const session=await app.createSession(db,scope,{productId:classProduct.id,startsAt:at(13),timezone:'UTC',providerIds:[],resourceIds:[],capacity:10,notes:'Synthetic',idempotencyKey:randomUUID()})
  const bookings=[]
  for(const [i,contactId]of [customer.id,another.id].entries()){
   // Synthetic agreement-owned enrollments; the legacy enroll command intentionally creates its own policy-free agreement.
   const booking=await db.appointmentBooking.create({data:{company_id:company.id,branch_id:branch.id,session_id:session.id,contact_id:contactId,status:'CONFIRMED',quantity:'1',created_by:actor.id,
    commercial_snapshot:{name:'Synthetic class',unit:'sesión',quantity:'1',quantityDecimals:0,unitPrice:'100.00',total:'100.00',currencyCode:'GTQ'},policy_snapshot:profile}});bookings.push(booking)
   const e=agreements[i]
   await db.appointmentEngagementSchedule.create({data:{company_id:company.id,branch_id:branch.id,engagement_id:e.id,line_id:e.lines[0].id,session_id:session.id,session_type:'SCHEDULED_SERVICE',booking_id:booking.id,kind:'BOOKING',quantity:'1',conditions_hash:e.lines[0].conditionsVersion}})
  }
  await payment(agreements[0],'25.00')
  const input={sessionId:session.id,action:'START',now:new Date(Date.parse(at(13))-60000),idempotencyKey:randomUUID()}
  await other.$transaction(tx=>guard(tx,scope,{...input,bookingId:bookings[0].id}))
  await assert.rejects(()=>other.$transaction(tx=>guard(tx,scope,{...input,bookingId:bookings[1].id})),{code:'EVENT_PAYMENT_CONDITIONS_REQUIRED'})
  await other.$transaction(tx=>guard(tx,scope,input))
 })
 await t.test('failure of a second program rolls back the first schedule, reference, history and idempotency receipt',async()=>{
  const e=await make(8,'2'),raw={expectedVersion:e.version,partial:false,idempotencyKey:randomUUID(),programs:Array.from({length:2},()=>({lineId:e.lines[0].id,quantity:'1',startsAt:at(8),endsAt:at(8,60),timezone:'UTC',providerIds:[],resourceIds:[],organizerId:actor.id,venue:{kind:'BRANCH'},acknowledgedConditionsVersion:e.lines[0].conditionsVersion}))}
  await assert.rejects(()=>programEngagement(db,scope,e.id,raw),{code:'SCHEDULE_CONFLICT'})
  assert.equal(await db.appointmentEngagementSchedule.count({where:{engagement_id:e.id}}),0)
  assert.equal((await db.appointmentEngagement.findUnique({where:{id:e.id}})).event_payment_reference,null)
  assert.equal(await db.appointmentRequest.count({where:{company_id:company.id,idempotency_key:raw.idempotencyKey}}),0)
  assert.equal(await db.appointmentEngagementHistory.count({where:{engagement_id:e.id,action:'PROGRAMMED'}}),0)
 })
 t.diagnostic('Two independent clients; synthetic company only. No active database, active generated client, external endpoint or deployed migration changed.')
})
