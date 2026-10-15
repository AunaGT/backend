const {assertDevTarget,approvedDevTarget}=require('../../scripts/salesDevTarget')
const devDbEnabled=process.env.AUNA_DEV_DB_APPROVAL==='YES'
const crypto=require('node:crypto'),fs=require('node:fs'),os=require('node:os'),path=require('node:path')
async function withDevDb(run){
  require('../../src/config/loadEnv')
  const url=process.env.DIRECT_URL
  approvedDevTarget(url)
  const {PrismaClient}=require('@prisma/client')
  const db=new PrismaClient({datasources:{db:{url}}})
  try{return await run(db)}finally{await db.$disconnect()}
}
async function withSalesDevFixture(run){
  return withDevDb(async db=>{
    const ids=Array.from({length:12},()=>crypto.randomUUID())
    const [companyId,branchId,secondBranchId,userId,productId,contactId,providerId,resourceId,groupSessionId,confirmedBookingId]=ids
    const scope={companyId,branchId,branchIds:[branchId,secondBranchId],userId,isAdmin:true,permissions:[]}
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'auna-sales-qa-'));fs.chmodSync(dir,0o700)
    const ledger={companyId,branchIds:scope.branchIds,userId,createdAt:new Date().toISOString(),retained:true}
    const ledgerPath=path.join(dir,'ledger.json')
    fs.writeFileSync(ledgerPath,JSON.stringify(ledger),{mode:0o600})
    const f={companyId,branchId,secondBranchId,userId,productId,contactId,providerId,resourceId,groupSessionId,confirmedBookingId,now:new Date()}
    try{
      await db.$transaction(async tx=>{
        f.company=await tx.company.create({data:{id:companyId,name:`QA-SALES-DRAFTS-${companyId}`,code:companyId.slice(0,16)}})
        await tx.branch.createMany({data:[{id:branchId,company_id:companyId,name:'QA principal',code:'QA1'},{id:secondBranchId,company_id:companyId,name:'QA secundaria',code:'QA2'}]})
        const role=await tx.role.create({data:{name:`qa-sales-${companyId}`,company_id:companyId}});ledger.roleId=role.id
        await tx.user.create({data:{id:userId,name:'QA ventas',email:`${userId}@example.invalid`,password:'not-a-real-login',role_id:role.id}})
        await tx.userCompany.create({data:{user_id:userId,company_id:companyId,role_id:role.id}})
        await tx.userBranch.createMany({data:scope.branchIds.map(branch_id=>({branch_id,user_id:userId}))})
        await tx.companyModule.createMany({data:['appointments','sales','inventory','contacts','receivables','quotes','orders'].map(module_code=>({company_id:companyId,module_code,status:'ACTIVE'})).concat([{company_id:companyId,module_code:'accounting',status:'DISABLED'}])})
        await tx.systemSetting.createMany({data:[['inventory_services_enabled','true','boolean'],['currency_code','GTQ','string'],['sales_allow_credit','true','boolean']].map(([key,value,type])=>({company_id:companyId,key,value,type}))})
        const category=await tx.productCategory.create({data:{company_id:companyId,name:'QA servicios'}})
        const status=await tx.stockStatus.findFirst({orderBy:{id:'asc'}})
        if(!status)throw Error('Existing stock status required; global seed is forbidden')
        f.categoryId=category.id;f.stockStatusId=status.id;f.workProductId=crypto.randomUUID();f.goodsId=crypto.randomUUID();f.goodsSupplierId=crypto.randomUUID()
        await tx.supplier.create({data:{id:f.goodsSupplierId,company_id:companyId,name:'QA proveedor',contact:'QA proveedor',party_type:'SUPPLIER'}})
        await tx.product.createMany({data:[{id:productId,name:'QA asesoría',kind:'SERVICE',service_unit_label:'Hora',quantity_decimals:2,price:100,cost:0},{id:f.workProductId,name:'QA evento',kind:'SERVICE',service_unit_label:'Evento',quantity_decimals:0,price:500,cost:0},{id:f.goodsId,name:'QA material',kind:'STANDARD',supplier_id:f.goodsSupplierId,price:25,cost:10}].map(p=>({...p,company_id:companyId,category_id:category.id,status_id:status.id}))})
        await tx.supplier.create({data:{id:contactId,company_id:companyId,name:'QA cliente',contact:'QA cliente',party_type:'CUSTOMER',credit_limit:10000}})
        await tx.serviceProvider.create({data:{id:providerId,company_id:companyId,name:'QA profesional',user_id:userId,created_by:userId}})
        await tx.serviceProviderBranch.createMany({data:scope.branchIds.map(branch_id=>({company_id:companyId,provider_id:providerId,branch_id}))})
        await tx.scheduleResource.create({data:{id:resourceId,company_id:companyId,branch_id:branchId,name:'QA sala',type:'ROOM',person_capacity:5}})
        f.method=await tx.paymentMethod.findFirst({where:{is_credit:false,NOT:{name:{in:['Efectivo','Cash'],mode:'insensitive'}}},orderBy:{id:'asc'}})
        f.creditMethod=await tx.paymentMethod.findFirst({where:{is_credit:true},orderBy:{id:'asc'}})
        f.saleStatus=await tx.saleStatus.findUnique({where:{name:'Completada'}})
        if(!f.method||!f.creditMethod||!f.saleStatus)throw Error('Existing payment methods/status required; no global seed')
        f.priorSale=await tx.sale.create({data:{branch_id:branchId,customer_contact_id:contactId,customer:'QA cliente',total:90,adjusted_total:90,items:0,payment_method_id:f.creditMethod.id,status_id:f.saleStatus.id,payment_status:'PENDING',created_by:userId,confirmed_at:new Date()}})
      },{timeout:60000,maxWait:5000})
      fs.writeFileSync(ledgerPath,JSON.stringify(ledger),{mode:0o600})
      const {DateTime}=require('luxon')
      const startsAt=DateTime.now().setZone('America/Guatemala').plus({days:1}).set({hour:9,minute:0,second:0,millisecond:0}).toUTC().toISO()
      f.individualInput={productId,contactId,startsAt,timezone:'America/Guatemala',providerIds:[providerId],resourceIds:[],quantity:'1',notes:'',idempotencyKey:crypto.randomUUID()}
      const profile={enabled:true,mode:'INDIVIDUAL',durationMinutes:45,beforeMinutes:0,afterMinutes:0,intervalMinutes:15,leadMinutes:0,horizonDays:60,cancellationHours:24,confirmation:'AUTOMATIC',capacity:1,requiresProvider:true,requiresResource:false,branchIds:scope.branchIds,providerIds:[providerId],resourceIds:[],instructions:''}
      const calendar={timezone:'America/Guatemala',expectedVersion:0,weekly:Array.from({length:7},(_,i)=>({weekday:i+1,from:'00:00',to:'24:00'})),exceptions:[]}
      await require('../../src/modules/appointments/application').withAgendaTransaction(db,companyId,async tx=>{
        const {saveCalendar}=require('../../src/modules/appointments/calendars'),{saveServiceProfile}=require('../../src/modules/appointments/profiles')
        for(const branch of scope.branchIds)await saveCalendar(tx,scope,'branch',branch,calendar)
        await saveCalendar(tx,scope,'provider',providerId,{...calendar,weekly:[],inheritBranch:true})
        await saveCalendar(tx,scope,'resource',resourceId,{...calendar,weekly:[],inheritBranch:true})
        await saveServiceProfile(tx,scope,productId,profile)
        await saveServiceProfile(tx,scope,f.workProductId,{...profile,schedulingStyle:'WORK',durationPolicy:'EDITABLE',requiresProvider:false,providerIds:[],allowedVenueKinds:['BRANCH','EVENT_VENUE']})
      })
      await db.$transaction(async tx=>{
        const {lineSnapshot}=require('../../src/services/catalogItemRules'),{publicConditionsFromRow}=require('../../src/modules/appointments')
        const lines=[]
        for(const [id,price]of [[productId,100],[f.workProductId,50],[f.goodsId,25]]){
          const product=await tx.product.findUnique({where:{id},include:{service_schedule_profile:true}})
          const service=publicConditionsFromRow(product.service_schedule_profile)
          lines.push({product_id:id,...lineSnapshot(product),qty:1,unit_price:price,line_total:price,sort_order:lines.length,...(service?{service_schedule_snapshot:service}:{})})
        }
        const quote=await tx.commercialDocument.create({data:{branch_id:branchId,doc_type:'QUOTE',status:'ACCEPTED',customer_contact_id:contactId,customer:'QA cliente',total:175,subtotal:175,created_by:userId,lines:{create:lines}},include:{lines:{orderBy:{sort_order:'asc'}}}})
        f.quoteId=quote.id;f.quoteLines=quote.lines
        const location=await require('../../src/services/stockLocations').defaultLocationId(tx,branchId)
        await tx.productStockLocation.create({data:{product_id:f.goodsId,location_id:location,stock:10}})
        await tx.productStock.create({data:{product_id:f.goodsId,branch_id:branchId,stock:10}})
        await tx.product.update({where:{id:f.goodsId},data:{stock:10}})
      },{timeout:60000,maxWait:5000})
      f.saleTerms={paymentCondition:'CREDIT',dueDate:new Date(Date.now()+86400000).toISOString().slice(0,10)}
      f.paidEngagement=async(amount,paymentExtras={})=>{
        const e=await require('../../src/modules/appointments/engagements').createEngagement(db,scope,{quoteId:f.quoteId,idempotencyKey:crypto.randomUUID()})
        const result=await require('../../src/modules/appointments/engagementPayments').collectEngagementPayment(db,scope,e.id,{amount,paymentMethodId:f.method.id,currencyCode:'GTQ',paidAt:new Date().toISOString(),expectedVersion:e.version,idempotencyKey:crypto.randomUUID(),...paymentExtras})
        return result.engagement
      }
      return await run({db,scope,fixtures:f,ledger,ledgerPath})
    }finally{
      ledger.fixtures=Object.fromEntries(Object.entries(f).filter(([key,value])=>key.endsWith('Id')&&typeof value==='string'))
      fs.writeFileSync(ledgerPath,JSON.stringify(ledger),{mode:0o600})
      console.log(`QA data ledger: ${ledgerPath}`)
    }
  })
}
async function snapshotSaleEffects(db,scope,engagementId){
  const sales=await db.sale.findMany({where:{branch_id:scope.branchId,origin_engagement_id:engagementId},select:{id:true}}),ids=sales.map(s=>s.id)
  return {
    salePayments:await db.salePaymentEntry.count({where:{sale_id:{in:ids}}}),
    saleJournals:await db.journalEntry.count({where:{company_id:scope.companyId,source_type:'SALE',source_id:{in:ids}}}),
    stockMovements:await db.stockMovement.count({where:{branch_id:scope.branchId}}),
    priorSalePayments:await db.salePaymentEntry.count({where:{sale:{branch_id:scope.branchId,origin_engagement_id:null}}}),
    receipts:await db.customerPayment.count({where:{branch_id:scope.branchId}}),
  }
}
module.exports={assertDevTarget,approvedDevTarget,devDbEnabled,withDevDb,withSalesDevFixture,snapshotSaleEffects}
