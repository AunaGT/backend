// Opt-in acceptance against a loopback disposable database; never application data.
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto')
const target=process.env.PACKAGES_TEST_DATABASE_URL
let endpoint;try{endpoint=new URL(target)}catch{throw Error('PACKAGES_TEST_DATABASE_URL is required')}
if(!['postgres:','postgresql:'].includes(endpoint.protocol)||!['127.0.0.1','localhost','[::1]'].includes(endpoint.hostname)||!/^\/auna_packages_test_[a-z0-9_]+$/.test(endpoint.pathname)||endpoint.search||endpoint.hash||target===process.env.DATABASE_URL||target===process.env.DIRECT_URL)throw Error('Refusing a non-isolated packages database')
process.env.DATABASE_URL=target;process.env.DIRECT_URL=target
const {PrismaClient,Prisma}=require('@prisma/client'),Packages=require('../src/services/commercialPackages'),catalog=require('../src/modules/inventory/packages/catalog')
const {withMocks,jsonResponse}=require('./helpers/reportHarness.cjs')
test('real package quotation preserves agreement through editing, acceptance, catalogue change and separate conversion paths',async t=>{
 const db=new PrismaClient({datasources:{db:{url:target}}});t.after(()=>db.$disconnect())
 const role=await db.role.findFirst({where:{system_key:'ADMIN'}});assert.ok(role)
 const company=await db.company.create({data:{name:'Synthetic package acceptance',code:randomUUID().slice(0,12)}})
 const actor=await db.user.create({data:{name:'Synthetic owner',email:randomUUID()+'@invalid.test',password:'synthetic-only',role_id:role.id}})
 await db.userCompany.create({data:{company_id:company.id,user_id:actor.id,role_id:role.id}})
 const branch=await db.branch.create({data:{company_id:company.id,name:'Synthetic branch',code:'ACC'}})
 await db.userBranch.create({data:{user_id:actor.id,branch_id:branch.id}})
 const customer=await db.supplier.create({data:{company_id:company.id,party_type:'CUSTOMER',name:'Synthetic customer',contact:'QA',tax_id:'123-K'}})
 const category=await db.productCategory.create({data:{company_id:company.id,name:'Synthetic'}}),status=await db.stockStatus.findFirst()
 await db.systemSetting.createMany({data:[{company_id:company.id,key:'inventory_services_enabled',value:'true'},{company_id:company.id,key:'currency_code',value:'GTQ'}]})
 await db.companyModule.create({data:{company_id:company.id,module_code:'appointments',status:'ACTIVE'}})
 if(!await db.saleStatus.findUnique({where:{name:'Borrador'}}))await db.saleStatus.create({data:{name:'Borrador'}})
 const products=[]
 for(const [name,kind]of [['Limón','STANDARD'],['Mora','STANDARD'],['Atención','SERVICE'],['Ingrediente','STANDARD']]){
  const p=await db.product.create({data:{company_id:company.id,name,kind,category_id:category.id,status_id:status.id,cost:kind==='SERVICE'?'0':'1',price:'999',stock:'0',min_stock:'0',...(kind==='SERVICE'?{service_unit_label:'hora',quantity_decimals:1}:{})}})
  products.push(p);if(kind!=='SERVICE')await db.productStock.create({data:{product_id:p.id,branch_id:branch.id,stock:'10000',min_stock:'0'}})
 }
 const permissions=['products.view','products.edit','quotes.view','quotes.create','quotes.manage','sales.create','appointments.view','appointments.create','appointments.view_team','receivables.view']
 const scope={companyId:company.id,actorId:actor.id,userId:actor.id,branchId:branch.id,branchIds:[branch.id],isAdmin:true,permissions}
 const variantId=randomUUID(),choiceId=randomUUID(),optionIds=[randomUUID(),randomUUID()]
 const definition={schemaVersion:1,name:'Experiencia sintética',description:'',imageUrl:null,currency:'GTQ',variants:[{id:variantId,name:'160 unidades',price:'1599.00',components:[{id:randomUUID(),productId:products[2].id,quantity:'1',presentationId:null,unitRevision:1,weight:'20'}],choices:[{id:choiceId,name:'Sabores',totalQuantity:'160',maxDistinct:2,weight:'80',options:products.slice(0,2).map((p,i)=>({id:optionIds[i],productId:p.id,presentationId:null,unitRevision:1}))}]}]}
 const input={expectedVersion:0,definition,branchIds:[branch.id],idempotencyKey:randomUUID()},saved=await catalog.savePackage(db,scope,null,input)
 assert.deepEqual(await catalog.savePackage(db,scope,null,input),saved,'lost response retries return same package')
 const active=await catalog.activatePackageVersion(db,scope,saved.id,{expectedVersion:1,idempotencyKey:randomUUID()})
 const selection={groupId:randomUUID(),packageId:saved.id,version:1,variantId,choices:[{choiceId,items:[{optionId:optionIds[0],quantity:'80'}]}]}
 const req=(body,id)=>({companyId:company.id,branchId:branch.id,userBranchIds:[branch.id],user:{sub:actor.id,permissions},params:{id},body})
 const read=id=>db.commercialDocument.findUnique({where:{id},include:{lines:{orderBy:{sort_order:'asc'}}}})
 await withMocks({[require.resolve('../src/models/prisma')]:{prisma:db,prismaTransaction:db},[require.resolve('../src/services/customerPagesPublic')]:{resolvePublicPortal:async()=>null}},require.resolve('../src/modules/quotes/controller'),async controller=>{
  async function invoke(method,body,id){const res=jsonResponse();let error;await controller[method](req(body,id),res,e=>{error=e});if(error)throw error;assert.ok(res.statusCode<400,JSON.stringify(res.body));return res.body}
  let quote=await invoke('create',{customer_contact_id:customer.id,customer:'QA',items:[],packages:[selection]})
  assert.equal(quote.package_groups[0].state,'INCOMPLETE');assert.equal(quote.lines.length,0);assert.equal(String(quote.total),'0')
  await assert.rejects(invoke('updateStatus',{status:'SENT'},quote.id),{code:'PACKAGE_SELECTION_INCOMPLETE'})
  assert.equal(await db.stockReservation.count({where:{branch_id:branch.id}}),0)
  const complete={...selection,choices:[{choiceId,items:optionIds.map(optionId=>({optionId,quantity:'80'}))}]}
  quote=await invoke('update',{items:[],packages:[complete],expectedRevision:quote.integration_revision},quote.id)
  assert.equal(quote.package_groups[0].state,'COMPLETE');assert.equal(quote.lines.length,3);Packages.assertPackageAgreement(quote)
  const before=await read(quote.id)
  await assert.rejects(invoke('update',{items:[],packages:[complete],expectedRevision:randomUUID()},quote.id),{code:'DOCUMENT_CHANGED'})
  assert.deepEqual(await read(quote.id),before)
  await invoke('updateStatus',{status:'SENT'},quote.id);quote=await read(quote.id)
  assert.ok((await db.stockReservation.count({where:{document_id:quote.id,status:'ACTIVE'}}))>0)
  const res=jsonResponse();let acceptError;await controller.respondPublic({params:{token:quote.public_token},body:{status:'ACCEPTED'}},res,e=>{acceptError=e});assert.equal(acceptError,undefined)
  quote=await read(quote.id);assert.equal(quote.status,'ACCEPTED')
  const definition2=structuredClone(definition);definition2.variants[0].price='1999.00'
  const version2=await catalog.savePackage(db,scope,saved.id,{...input,definition:definition2,expectedVersion:active.version,idempotencyKey:randomUUID()})
  const published2=await catalog.activatePackageVersion(db,scope,saved.id,{expectedVersion:version2.version,idempotencyKey:randomUUID()})
  const reloaded=await db.$transaction(tx=>Packages.buildPackageGroups(tx,scope,[complete],{existingGroups:quote.package_groups}))
  assert.equal(reloaded.groups[0].amount,'1599.00')
  const order=await invoke('convertToOrder',{},quote.id);assert.equal(order.fulfillment_mode,'SEPARATE');Packages.assertPackageAgreement(order);assert.deepEqual(order.package_groups,quote.package_groups)
  const cloneQuote=async()=>db.commercialDocument.create({data:{branch_id:branch.id,doc_type:'QUOTE',status:'ACCEPTED',customer_contact_id:customer.id,created_by:actor.id,subtotal:quote.subtotal,discount_total:quote.discount_total,total:quote.total,package_groups:quote.package_groups,
   lines:{create:quote.lines.map(l=>{const {id,document_id,created_at,updated_at,...line}=l;return{...line,service_schedule_snapshot:l.service_schedule_snapshot??Prisma.DbNull}})}}})
  const saleQuote=await cloneQuote(),draft=await require('../src/modules/quotes/saleDraft').createQuoteSaleDraft(db,scope,saleQuote.id)
  const sale=await db.sale.findUnique({where:{id:draft.id},include:{sale_items:true}});Packages.assertPackageAgreement(sale,{kind:'SALE'});assert.equal(String(sale.total),'1599')
  assert.equal((await require('../src/modules/quotes/saleDraft').createQuoteSaleDraft(db,scope,saleQuote.id)).id,draft.id)
  const agendaQuote=await cloneQuote(),engagement=await require('../src/modules/appointments/engagements').createEngagement(db,scope,{quoteId:agendaQuote.id,idempotencyKey:randomUUID()})
  assert.equal(engagement.packageGroups[0].amount,'1599.00');assert.equal(engagement.lines.filter(l=>l.packageComponentKey).length,3);assert.ok(engagement.lines.every(l=>!l.schedules.length))
  const storedEngagement=await db.appointmentEngagement.findUnique({where:{id:engagement.id},include:{customer:true,lines:{orderBy:{sort_order:'asc'}}}})
  await db.$transaction(tx=>require('../src/modules/appointments/sourceVerification').lockEngagementQuote(tx,scope,storedEngagement))
  assert.equal(engagement.lines.find(l=>l.productId===products[0].id).unitPrice,'7.995')
  const agendaDraft=await db.$transaction(tx=>require('../src/modules/sales/engagementSale').ensureEngagementDraft(tx,scope,{source:storedEngagement}))
  const agendaSale=await db.sale.findUnique({where:{id:agendaDraft.saleId},include:{sale_items:true}})
  Packages.assertPackageAgreement(agendaSale,{kind:'SALE'});assert.equal(agendaSale.sale_items.find(l=>l.product_id===products[0].id).price.toFixed(),'7.995')
  const foreign=await db.company.create({data:{name:'Synthetic foreign',code:randomUUID().slice(0,12)}}),other=await db.branch.create({data:{company_id:foreign.id,name:'Other',code:'OTH'}})
  await assert.rejects(()=>catalog.getPackage(db,{...scope,companyId:foreign.id,branchId:other.id,branchIds:[other.id]},saved.id),{status:404})
  await assert.rejects(()=>catalog.getPackage(db,{...scope,isAdmin:false,permissions:[]},saved.id),{status:403})
  await db.product.update({where:{id:products[0].id},data:{available_for_sale:false}})
  await assert.rejects(()=>db.$transaction(tx=>Packages.buildPackageGroups(tx,scope,[complete],{existingGroups:quote.package_groups})),{status:404})
  await db.product.update({where:{id:products[0].id},data:{available_for_sale:true}})
  await db.product.update({where:{id:products[0].id},data:{unit_revision:2}})
  await assert.rejects(()=>db.$transaction(tx=>Packages.buildPackageGroups(tx,scope,[complete],{existingGroups:quote.package_groups})),{code:'UNIT_REVISION_CONFLICT'})
  await db.product.update({where:{id:products[0].id},data:{unit_revision:1}})
  await db.systemSetting.update({where:{company_id_key:{company_id:company.id,key:'inventory_services_enabled'}},data:{value:'false'}})
  await assert.rejects(()=>db.$transaction(tx=>Packages.buildPackageGroups(tx,scope,[complete],{existingGroups:quote.package_groups})),{status:403})
  await db.systemSetting.update({where:{company_id_key:{company_id:company.id,key:'inventory_services_enabled'}},data:{value:'true'}})
  await assert.rejects(()=>catalog.savePackage(db,scope,null,{...input,definition:{...definition,currency:'USD'},idempotencyKey:randomUUID()}),{code:'CURRENCY_MISMATCH'})
  const pair=await db.$transaction(tx=>Packages.buildPackageGroups(tx,scope,[{...complete,groupId:randomUUID(),version:published2.activeVersion},{...complete,groupId:randomUUID(),version:published2.activeVersion}]))
  assert.equal(new Set(pair.lines.map(l=>l.package_component_key)).size,6);assert.equal(pair.lines.filter(l=>l.product_id===products[0].id).length,2)
  await assert.rejects(()=>db.$transaction(async tx=>{await tx.commercialDocument.update({where:{id:quote.id},data:{notes:'ROLLBACK'}});throw Error('synthetic rollback')}),/synthetic rollback/)
  assert.notEqual((await read(quote.id)).notes,'ROLLBACK')
  assert.equal(await db.stockMovement.count({where:{branch_id:branch.id}}),0,'draft conversions never dispatch goods')
  assert.equal(await db.saleDte.count({where:{sale:{branch_id:branch.id}}}),0)
  for(const p of products.filter(p=>p.kind!=='SERVICE'))assert.equal(String((await db.productStock.findUnique({where:{product_id_branch_id:{product_id:p.id,branch_id:branch.id}}})).stock),'10000')
 })
 t.diagnostic('Synthetic PostgreSQL quote/order/sale-draft/Agenda journey; no endpoint or active-company record touched. Partial stock/returns use the real-domain regression suites separately.')
})
