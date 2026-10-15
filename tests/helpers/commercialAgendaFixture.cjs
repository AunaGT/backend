const crypto=require('node:crypto')
const {withAppointmentsTestDb,seedAgenda}=require('./appointmentsTestDb.cjs')
async function withCommercialAgendaTestDb(run){
  return withAppointmentsTestDb(async context=>{
    const {db,scope,fixtures:f}=context
    await seedAgenda(context)
    await db.product.update({where:{id:f.productId},data:{quantity_decimals:2,service_unit_label:'Hora'}})
    const original=await db.product.findUnique({where:{id:f.productId}})
    const {saveServiceProfile}=require('../../src/modules/appointments/profiles')
    const {presentProfile}=require('../../src/modules/appointments/profiles')
    const profile=presentProfile(await db.serviceScheduleProfile.findUnique({where:{product_id:f.productId},include:{branches:true,providers:true,resources:true}})).profile
    f.workProductId=crypto.randomUUID();f.goodsId=crypto.randomUUID()
    await db.product.create({data:{id:f.workProductId,company_id:scope.companyId,name:'Show QA',kind:'SERVICE',service_unit_label:'Evento',quantity_decimals:0,category_id:original.category_id,status_id:original.status_id,price:500,cost:0}})
    await db.product.create({data:{id:f.goodsId,company_id:scope.companyId,name:'Material QA',category_id:original.category_id,status_id:original.status_id,price:25,cost:10}})
    await db.$transaction(tx=>saveServiceProfile(tx,scope,f.workProductId,{...profile,expectedVersion:0,schedulingStyle:'WORK',durationPolicy:'EDITABLE',requiresProvider:false,providerIds:[],allowedVenueKinds:['BRANCH','EVENT_VENUE']}))
    const {publicConditionsFromRow}=require('../../src/modules/appointments')
    const items=[]
    for(const [productId,price] of [[f.productId,'100'],[f.workProductId,'50'],[f.goodsId,'25']]){
      const product=await db.product.findUnique({where:{id:productId},include:{service_schedule_profile:true}})
      const {lineSnapshot}=require('../../src/services/catalogItemRules')
      const snapshot=publicConditionsFromRow(product.service_schedule_profile)
      items.push({product_id:productId,...lineSnapshot(product),qty:'1',unit_price:price,line_total:price,sort_order:items.length,...(snapshot?{service_schedule_snapshot:snapshot}:{})})
    }
    const quote=await db.commercialDocument.create({data:{branch_id:scope.branchId,doc_type:'QUOTE',status:'ACCEPTED',customer_contact_id:f.contactId,customer:'Cliente QA',total:175,subtotal:175,created_by:scope.userId,lines:{create:items}},include:{lines:{orderBy:{sort_order:'asc'}}}})
    f.quoteId=quote.id;f.quoteLines=quote.lines
    f.method=await db.paymentMethod.create({data:{name:'Transferencia QA'}})
    f.creditMethod=await db.paymentMethod.create({data:{name:'Crédito QA',is_credit:true}})
    f.saleStatus=await db.saleStatus.create({data:{name:'Completada'}})
    f.priorSale=await db.sale.create({data:{branch_id:scope.branchId,customer_contact_id:f.contactId,total:90,adjusted_total:90,items:1,payment_method_id:f.creditMethod.id,status_id:f.saleStatus.id,payment_status:'PENDING',created_by:scope.userId}})
    f.saleTerms={paymentCondition:'CREDIT',dueDate:new Date(Date.now()+86400000).toISOString().slice(0,10)}
    f.paidEngagement=async(amount,paymentExtras={})=>{
      const e=await require('../../src/modules/appointments/engagements').createEngagement(db,scope,{quoteId:f.quoteId,idempotencyKey:crypto.randomUUID()})
      const result=await require('../../src/modules/appointments/engagementPayments').collectEngagementPayment(db,scope,e.id,{amount,paymentMethodId:f.method.id,currencyCode:'GTQ',paidAt:new Date().toISOString(),expectedVersion:e.version,idempotencyKey:crypto.randomUUID(),...paymentExtras})
      return result.engagement
    }
    f.cancelledPaidEngagement=async(amount,paymentExtras={})=>{
      const commands=require('../../src/modules/appointments/engagements')
      const e=await f.paidEngagement(amount,paymentExtras),line=e.lines.find(l=>l.productId===f.workProductId)
      const scheduled=await commands.programEngagement(db,scope,e.id,{expectedVersion:e.version,idempotencyKey:crypto.randomUUID(),partial:true,programs:[{lineId:line.id,quantity:'1',startsAt:f.individualInput.startsAt,timezone:'America/Guatemala',providerIds:[],resourceIds:[],acknowledgedConditionsVersion:line.conditionsVersion}]})
      const record=scheduled.lines.find(l=>l.id===line.id).schedules[0]
      const activities=require('../../src/modules/appointments/activities'),activity=await activities.getActivity(db,scope,record.sessionId)
      await activities.transitionActivity(db,scope,activity.id,{action:'CANCEL',expectedVersion:activity.version,idempotencyKey:crypto.randomUUID(),reason:'Evento cancelado'})
      const cancelled=await commands.getEngagement(db,scope,e.id)
      const receipt=await db.customerPayment.findFirst({where:{commitments:{some:{engagement_id:e.id}}}})
      const request=await require('../../src/modules/appointments/engagementResolution').resolveEngagementFunds(db,scope,e.id,{action:'REQUEST_REFUND',amount:'10.00',receiptId:receipt.id,reason:'Cancelación',expectedVersion:cancelled.version,idempotencyKey:crypto.randomUUID()})
      const refund=await db.customerPaymentRefund.findFirst({where:{engagement_id:e.id,status:'REQUESTED'}})
      f.refundInput={amount:'10.00',receiptId:receipt.id,refundId:refund.id,reason:'Reintegro acordado'}
      return request
    }
    await run(context)
  },{version:'commercial'})
}
async function configureAccounting(db,scope,{full=false}={}){
  const definitions=[['cash','1101','ASSET'],['bank','1102','ASSET'],['receivables','1103','ASSET'],['customerAdvances','2103','LIABILITY']]
  if(full){const {DEFAULT_ACCOUNT_KEYS}=require('../../src/services/accounting/core');for(const key of DEFAULT_ACCOUNT_KEYS)if(!definitions.some(d=>d[0]===key))definitions.push([key,String(3000+definitions.length),key==='sales'?'INCOME':['cogs','pequenoTaxExpense','salesReturns'].includes(key)?'EXPENSE':['ivaDebit','pequenoTax','payables'].includes(key)?'LIABILITY':'ASSET'])}
  const accounts={}
  for(const [key,code,type]of definitions)accounts[key]=await db.account.create({data:{company_id:scope.companyId,code,name:key,type}})
  await db.systemSetting.create({data:{company_id:scope.companyId,key:'accounting.defaultAccounts',type:'json',value:JSON.stringify(Object.fromEntries(Object.entries(accounts).map(([key,row])=>[key,row.code])))}})
  return accounts
}
async function createDeliveredOrder(db,scope,f){
  const quote=await db.commercialDocument.findUnique({where:{id:f.quoteId},include:{lines:true}})
  const order=await db.commercialDocument.create({data:{branch_id:scope.branchId,doc_type:'ORDER',status:'FULFILLED',fulfillment_mode:'SEPARATE',converted_from_id:quote.id,customer_contact_id:f.contactId,customer:'Cliente QA',total:quote.total,subtotal:quote.subtotal,created_by:scope.userId,lines:{create:quote.lines.map(l=>({product_id:l.product_id,item_kind:l.item_kind,item_name:l.item_name,unit_label:l.unit_label,quantity_decimals:l.quantity_decimals,qty:l.qty,qty_fulfilled:l.qty,unit_price:l.unit_price,line_total:l.line_total,sort_order:l.sort_order}))}},include:{lines:true}})
  await db.orderDelivery.create({data:{document_id:order.id,request_key:crypto.randomUUID(),created_by:scope.userId,lines:{create:order.lines.map(l=>({document_line_id:l.id,qty:l.qty,unit_cost:l.item_kind==='SERVICE'?0:10}))}}})
  return order
}
module.exports={withCommercialAgendaTestDb,configureAccounting,createDeliveredOrder}
