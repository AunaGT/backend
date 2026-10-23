// Existing development data only; every write is inside an unconditional rollback.
const assert=require('node:assert/strict'),{randomUUID}=require('node:crypto')
async function main(args){
 assert.deepEqual(args,['--rollback']);require('../src/config/loadEnv')
 const {PrismaClient}=require('@prisma/client'),pooled=new URL(process.env.DATABASE_URL),direct=new URL(process.env.DIRECT_URL)
 assert.equal(pooled.hostname,direct.hostname);assert.equal(pooled.username,direct.username);assert.equal(pooled.pathname,direct.pathname);assert(direct.hostname.endsWith('.supabase.com'))
 const db=new PrismaClient({datasources:{db:{url:direct.toString()}},log:[]}),{rollbackCheckout,quietDiagnostic}=require('../scripts/diagnose-pos-checkout'),api=require('../src/modules/sales/manualSales')
 let phase='setup',saleId
 try{
  const {value}=await quietDiagnostic(async()=>{
   const recent=await db.sale.findFirst({where:{createdBy:{role:{name:'admin',system_key:'ADMIN',company_id:null}},branch:{active:true,company:{active:true}}},select:{branch_id:true,created_by:true,branch:{select:{company_id:true}}},orderBy:{date:'desc'}});assert(recent)
   const scope={companyId:recent.branch.company_id,branchId:recent.branch_id,userId:recent.created_by,permissions:[],isAdmin:true}
   const customer=await db.supplier.findFirst({where:{company_id:scope.companyId,party_type:'CUSTOMER',deleted:false,estado:1},select:{id:true}});assert(customer)
   const stock=await db.productStock.findFirst({where:{branch_id:scope.branchId,stock:{gt:10},product:{company_id:scope.companyId,deleted:false,available_for_sale:true,kind:'STANDARD'}},select:{product:{select:{id:true,unit_revision:true,unit_metadata_version:true,base_unit_id:true}}}});assert(stock)
   const product=stock.product,requestKey=randomUUID(),item={product_id:product.id,qty:'1',presentation_id:null,...(product.base_unit_id?{unit_revision:product.unit_revision}:{})}
   phase='transaction'
   const result=await rollbackCheckout(db,async tx=>{
    const boundary=new Proxy(tx,{get:(target,key)=>key==='$transaction'?run=>run(tx):target[key]})
    const initialStock=await tx.productStock.findFirst({where:{product_id:product.id,branch_id:scope.branchId}})
    const effects=async id=>Promise.all([tx.stockMovement.count({where:{ref_id:id}}),tx.salePaymentEntry.count({where:{sale_id:id}}),tx.saleDte.count({where:{sale_id:id}}),tx.journalEntry.count({where:{source_type:'SALE',source_id:id}})])
    phase='preview';const input={expectedVersion:0,idempotencyKey:requestKey,customerId:customer.id,customerName:'',customerNit:'',items:[item]},preview=await api.previewManualSale(boundary,scope,input)
    input.items[0].expected_unit_price=preview.items[0].unitPrice
    phase='save';const draft=await api.saveManualSale(boundary,scope,null,input);saleId=draft.id;assert.equal(draft.status,'DRAFT');assert.deepEqual(await effects(saleId),[0,0,0,0])
    const persisted=await tx.sale.findUnique({where:{id:saleId}});assert.equal(persisted.payment_method_id,null);assert.equal(persisted.cash_register_session_id,null)
    const afterDraftStock=await tx.productStock.findFirst({where:{product_id:product.id,branch_id:scope.branchId}});assert(afterDraftStock.stock.eq(initialStock.stock))
    phase='edit';const edited=await api.saveManualSale(boundary,scope,saleId,{...input,expectedVersion:1,idempotencyKey:randomUUID()});assert.equal(edited.version,2);assert.deepEqual(await effects(saleId),[0,0,0,0])
    phase='foreign-scope';await assert.rejects(api.readManualSale(boundary,{...scope,companyId:randomUUID()},saleId),{code:'NOT_FOUND'})
    phase='confirm';const confirm={expectedVersion:2,idempotencyKey:randomUUID(),dueDate:'2099-01-01',creditOverride:true},confirmed=await api.confirmManualSale(boundary,scope,saleId,confirm)
    assert.equal(confirmed.id,saleId);assert.equal(confirmed.status,'CONFIRMED');assert.equal(confirmed.total,draft.total)
    const afterConfirm=await effects(saleId);assert(afterConfirm[0]>0);assert.equal(afterConfirm[1],0);assert.equal(afterConfirm[2],0)
    const sale=await tx.sale.findUnique({where:{id:saleId},include:{payment_method:true}});assert.equal(sale.payment_status,'PENDING');assert.equal(sale.payment_method.is_credit,true);assert.equal(sale.amount_received,null)
    phase='replay';await api.confirmManualSale(boundary,scope,saleId,confirm);assert.deepEqual(await effects(saleId),afterConfirm)
    const remaining=await tx.productStock.findFirst({where:{product_id:product.id,branch_id:scope.branchId}});assert(initialStock.stock.sub(1).eq(remaining.stock))
    return{sameSale:true,draftWithoutEffects:true,confirmStockOnce:true,pendingWithoutPayment:true,fiscalRequests:0,foreignScopeDenied:true}
   })
   phase='verify-rollback';assert.equal(await db.sale.count({where:{id:saleId}}),0);assert.equal(await db.saleHistory.count({where:{sale_id:saleId}}),0)
   return{...result,rolledBack:true}
  })
  console.log(JSON.stringify(value))
 }catch(e){e.phase=phase;throw e}finally{await db.$disconnect()}
}
if(require.main===module)main(process.argv.slice(2)).catch(e=>{console.error(JSON.stringify({status:'error',phase:e.phase,name:e.name,code:/^(?:P\d{4}|[A-Z_]{3,50})$/.test(e.code||'')?e.code:'INTEGRATION_CHECK_FAILED',argument:/Unknown (?:argument|field) `([\w]+)`|Argument `([\w]+)`/.exec(e.message)?.slice(1).filter(Boolean),frames:e.stack?.split('\n').filter(l=>l.trim().startsWith('at ')&&!l.includes('node_modules')).slice(0,4).map(l=>l.trim())}));process.exitCode=1})
