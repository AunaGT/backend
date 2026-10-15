const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto')
const {withAppointmentsTestDb,seedAgenda}=require('./helpers/appointmentsTestDb.cjs')
test('commercial schema preserves existing agenda and defaults, with tenant-scoped sources',async()=>{
  await withAppointmentsTestDb(async context=>{
    const {db,scope,fixtures:f}=context
    await seedAgenda(context)
    const booking=await db.appointmentBooking.findUnique({where:{id:f.confirmedBookingId},include:{session:true}})
    assert.equal(booking.session.completion_policy,'MANUAL')
    assert.equal(booking.session.actual_completed_at,null)
    assert.equal((await db.serviceScheduleProfile.findUnique({where:{product_id:f.productId}})).public_instructions,'')
    const quote=await db.commercialDocument.create({data:{branch_id:scope.branchId,doc_type:'QUOTE',status:'ACCEPTED',customer_contact_id:f.contactId,total:'150',created_by:scope.userId,
      lines:{create:{product_id:f.productId,item_kind:'SERVICE',item_name:'Servicio QA',unit_label:'Sesión',qty:1,unit_price:150,line_total:150}}},include:{lines:true}})
    const data={company_id:scope.companyId,branch_id:scope.branchId,customer_id:f.contactId,source:'QUOTE',quote_id:quote.id,currency_code:'GTQ',agreed_total:150,commercial_snapshot:{},created_by:scope.userId}
    const engagement=await db.appointmentEngagement.create({data})
    await assert.rejects(()=>db.appointmentEngagement.create({data}),{code:'P2002'})
    const otherQuote=await db.commercialDocument.create({data:{branch_id:scope.branchId,doc_type:'QUOTE',total:10}})
    await assert.rejects(()=>db.appointmentEngagement.create({data:{...data,quote_id:otherQuote.id,branch_id:f.secondBranchId}}),{code:'P2003'})
    await assert.rejects(()=>db.appointmentEngagementLine.create({data:{company_id:scope.companyId,branch_id:scope.branchId,engagement_id:engagement.id,
      source_document_id:otherQuote.id,source_line_id:quote.lines[0].id,product_id:f.productId,item_kind:'SERVICE',item_name:'Otra',unit_label:'Sesión',qty:1,unit_price:150,line_total:150}}),{code:'P2003'})
    const foreign=await db.company.create({data:{name:'Otra empresa QA',code:crypto.randomUUID().slice(0,16)}})
    await assert.rejects(()=>db.appointmentEngagement.create({data:{...data,company_id:foreign.id,quote_id:null,source:'DIRECT'}}),{code:'P2003'})
    const otherContact=await db.supplier.create({data:{company_id:scope.companyId,name:'Otro cliente',contact:'QA',party_type:'CUSTOMER'}})
    const receipt=await db.customerPayment.create({data:{branch_id:scope.branchId,customer_id:otherContact.id,amount:'100',registered_by:scope.userId}})
    await assert.rejects(()=>db.paymentCommitment.create({data:{company_id:scope.companyId,branch_id:scope.branchId,customer_id:f.contactId,engagement_id:engagement.id,payment_id:receipt.id,amount:'100'}}),{code:'P2003'})
    const method=await db.paymentMethod.create({data:{name:'Transferencia QA'}})
    const status=await db.saleStatus.create({data:{name:'Completada QA'}})
    const sale=await db.sale.create({data:{branch_id:scope.branchId,total:150,adjusted_total:150,items:1,payment_method_id:method.id,status_id:status.id}})
    assert.equal(sale.settlement_source,'LEGACY')
    await db.appointmentEngagement.update({where:{id:engagement.id},data:{sale_id:sale.id}})
    await assert.rejects(()=>db.appointmentEngagement.create({data:{...data,source:'DIRECT',quote_id:null,sale_id:sale.id}}),{code:'P2002'})
    const differentBranchSale=await db.sale.create({data:{branch_id:f.secondBranchId,total:10,adjusted_total:10,items:1,payment_method_id:method.id,status_id:status.id}})
    await assert.rejects(()=>db.appointmentEngagement.update({where:{id:engagement.id},data:{sale_id:differentBranchSale.id}}),{code:'P2003'})
    assert.equal(await db.appointmentBooking.count({where:{company_id:scope.companyId}}),1)
    assert.equal((await db.commercialDocument.findUnique({where:{id:quote.id}})).total.toFixed(2),'150.00')
  },{version:'commercial'})
})

test('commercial delta retains every previous field and never publishes private instructions',async()=>{
  const {applyCommercialMigration}=require('./helpers/appointmentsTestDb.cjs')
  await withAppointmentsTestDb(async({db,scope,fixtures:f})=>{
    const profileId=crypto.randomUUID(),sessionId=crypto.randomUUID()
    await db.$executeRaw`INSERT INTO service_schedule_profiles (id,company_id,product_id,enabled,mode,duration_minutes,instructions,created_by,updated_at) VALUES (${profileId}::uuid,${scope.companyId}::uuid,${f.productId}::uuid,true,'INDIVIDUAL',45,'Información privada',${scope.userId}::uuid,NOW())`
    await db.$executeRaw`INSERT INTO appointment_sessions (id,company_id,branch_id,product_id,mode,starts_at,ends_at,occupied_from,occupied_until,timezone,capacity,policy_snapshot,created_by,updated_at) VALUES (${sessionId}::uuid,${scope.companyId}::uuid,${scope.branchId}::uuid,${f.productId}::uuid,'INDIVIDUAL','2030-01-01T18:00Z','2030-01-01T19:00Z','2030-01-01T18:00Z','2030-01-01T19:00Z','America/Guatemala',1,'{}'::jsonb,${scope.userId}::uuid,NOW())`
    const [beforeProfile]=await db.$queryRaw`SELECT * FROM service_schedule_profiles WHERE id=${profileId}::uuid`
    const [beforeSession]=await db.$queryRaw`SELECT * FROM appointment_sessions WHERE id=${sessionId}::uuid`
    await applyCommercialMigration(db)
    const profile=await db.serviceScheduleProfile.findUnique({where:{id:profileId}})
    const session=await db.appointmentSession.findUnique({where:{id:sessionId}})
    for(const key of Object.keys(beforeProfile)) assert.deepEqual(profile[key],beforeProfile[key],key)
    for(const key of Object.keys(beforeSession)) assert.deepEqual(session[key],beforeSession[key],key)
    assert.equal(profile.public_instructions,'')
    assert.equal(session.completion_policy,'MANUAL')
    assert.equal(session.actual_completed_at,null)
    assert.equal(await db.appointmentEngagement.count(),0)
    await assert.rejects(()=>db.appointmentRequest.create({data:{company_id:scope.companyId,actor_id:scope.userId,operation:'QA',idempotency_key:'qa',input_hash:'bad',result_type:'ENGAGEMENT',result_id:crypto.randomUUID()}}))
  },{version:'unified'})
})
