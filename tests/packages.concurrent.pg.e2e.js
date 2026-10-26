// Explicitly opt-in; uses synthetic records in the disposable packages database only.
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto')
const target=process.env.PACKAGES_TEST_DATABASE_URL
let endpoint
try{endpoint=new URL(target)}catch{throw Error('PACKAGES_TEST_DATABASE_URL is required')}
if(!['postgres:','postgresql:'].includes(endpoint.protocol)||!['127.0.0.1','localhost','[::1]'].includes(endpoint.hostname)||!/^\/auna_packages_test_[a-z0-9_]+$/.test(endpoint.pathname)||endpoint.search||endpoint.hash||target===process.env.DATABASE_URL||target===process.env.DIRECT_URL)throw Error('Refusing a non-isolated packages database')
process.env.DATABASE_URL=target;process.env.DIRECT_URL=target
const {PrismaClient,Prisma}=require('@prisma/client'),Packages=require('../src/services/commercialPackages')
const {withMocks,jsonResponse}=require('./helpers/reportHarness.cjs')
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r});return{promise,resolve}}
test('real row locks serialize package conversion and public acceptance reloads the current composition',async t=>{
  const db=new PrismaClient({datasources:{db:{url:target}}});t.after(()=>db.$disconnect())
  assert.equal((await db.$queryRaw`SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public' AND tablename='commercial_packages'`)[0].n,1,'Apply the migration test to this disposable database first')
  const company=await db.company.create({data:{name:'Synthetic package concurrency',code:randomUUID().slice(0,12)}})
  const role=await db.role.findFirst({where:{system_key:'ADMIN'}})
  assert.ok(role,'Synthetic fixture requires its existing test role')
  const actor=await db.user.create({data:{name:'Synthetic concurrency owner',email:randomUUID()+'@invalid.test',password:'synthetic-only',role_id:role.id}})
  await db.userCompany.create({data:{company_id:company.id,user_id:actor.id,role_id:role.id}})
  const branch=await db.branch.create({data:{company_id:company.id,name:'Synthetic branch',code:'CONC'}})
  await db.userBranch.create({data:{user_id:actor.id,branch_id:branch.id}})
  const customer=await db.supplier.create({data:{company_id:company.id,party_type:'CUSTOMER',name:'Synthetic customer',contact:'Synthetic',tax_id:'123-K'}})
  const category=await db.productCategory.create({data:{company_id:company.id,name:'Synthetic'}}),status=await db.stockStatus.findFirst()
  const product=await db.product.create({data:{company_id:company.id,name:'Synthetic service',category_id:category.id,status_id:status.id,
    kind:'SERVICE',service_unit_label:'hora',quantity_decimals:1,stock:'0',min_stock:'0',cost:'0',price:'999.00'}})
  await db.systemSetting.create({data:{company_id:company.id,key:'inventory_services_enabled',value:'true'}})
  if(!await db.saleStatus.findUnique({where:{name:'Borrador'}}))await db.saleStatus.create({data:{name:'Borrador'}})
  const scope={companyId:company.id,actorId:actor.id,userId:actor.id,branchId:branch.id,branchIds:[branch.id],isAdmin:true,permissions:[]}
  const definition={schemaVersion:1,name:'Concurrency package',description:'',imageUrl:null,currency:'GTQ',variants:[{id:randomUUID(),name:'One service',price:'19.99',components:[{id:randomUUID(),productId:product.id,quantity:'1',presentationId:null,unitRevision:product.unit_revision,weight:'1'}],choices:[]}]}
  const catalog=require('../src/modules/inventory/packages/catalog'),saved=await catalog.savePackage(db,scope,null,{expectedVersion:0,definition,branchIds:[branch.id],idempotencyKey:randomUUID()})
  await catalog.activatePackageVersion(db,scope,saved.id,{expectedVersion:saved.version,idempotencyKey:randomUUID()})
  const selection={groupId:randomUUID(),packageId:saved.id,version:1,variantId:definition.variants[0].id,choices:[]}
  const built=await db.$transaction(tx=>Packages.buildPackageGroups(tx,scope,[selection],{allowIncomplete:true}))
  const quoteData={branch_id:branch.id,doc_type:'QUOTE',status:'ACCEPTED',customer_contact_id:customer.id,created_by:actor.id,subtotal:built.subtotal,discount_total:'0',total:built.subtotal,
    package_groups:built.groups,lines:{create:built.lines.map((line,i)=>({...line,sort_order:i,service_schedule_snapshot:Prisma.DbNull}))}}
  const quote=await db.commercialDocument.create({data:quoteData})
  const {createQuoteSaleDraft}=require('../src/modules/quotes/saleDraft')
  const [first,second]=await Promise.all([createQuoteSaleDraft(db,scope,quote.id),createQuoteSaleDraft(db,scope,quote.id)])
  assert.equal(first.id,second.id)
  assert.equal(await db.sale.count({where:{branch_id:branch.id}}),1)
  assert.equal(await db.commercialDocumentSale.count({where:{document_id:quote.id}}),1)
  const sale=await db.sale.findUnique({where:{id:first.id},include:{sale_items:true,status:true}})
  assert.equal(sale.status.name,'Borrador');Packages.assertPackageAgreement(sale,{kind:'SALE'})
  assert.equal(await db.stockMovement.count({where:{branch_id:branch.id}}),0)
  assert.equal(await db.stockReservation.count({where:{branch_id:branch.id}}),0)

  const token=randomUUID(),publicQuote=await db.commercialDocument.create({data:{...quoteData,status:'SENT',public_token:token}})
  const locked=deferred(),release=deferred(),waiting=deferred()
  const writer=db.$transaction(async tx=>{
    await tx.$queryRaw`SELECT id FROM commercial_documents WHERE id=${publicQuote.id}::uuid FOR UPDATE`
    locked.resolve();await release.promise
    const incomplete=structuredClone(built.groups)
    Object.assign(incomplete[0],{state:'INCOMPLETE',amount:null,netAmount:null,components:[],issues:[{code:'PACKAGE_SELECTION_INCOMPLETE',message:'Selección en revisión',remainingQuantity:'1'}]})
    await tx.commercialDocument.update({where:{id:publicQuote.id},data:{package_groups:incomplete,lines:{deleteMany:{}}}})
  },{timeout:15000})
  await locked.promise
  const transaction={$transaction:fn=>db.$transaction(tx=>fn(new Proxy(tx,{get(obj,key){
    if(key==='$queryRaw')return async(strings,...values)=>{if(String(strings).includes('FOR UPDATE'))waiting.resolve();return obj.$queryRaw(strings,...values)}
    const value=obj[key];return typeof value==='function'?value.bind(obj):value
  }})),{timeout:15000})}
  try{
    await withMocks({[require.resolve('../src/models/prisma')]:{prisma:db,prismaTransaction:transaction}},require.resolve('../src/modules/quotes/controller'),async controller=>{
      const res=jsonResponse();let error
      const acceptance=controller.respondPublic({params:{token},body:{status:'ACCEPTED'}},res,e=>{error=e})
      await waiting.promise;release.resolve();await writer;await acceptance
      assert.equal(error?.code,'PACKAGE_SELECTION_INCOMPLETE')
      assert.equal((await db.commercialDocument.findUnique({where:{id:publicQuote.id}})).status,'SENT')
    })
  }finally{release.resolve();await writer}
  t.diagnostic('Synthetic data only: one draft/link, no stock movement, stale composition not accepted; no provider endpoints called')
})
