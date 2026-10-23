// Opt-in: existing Supabase development quotation, every write unconditionally rolled back.
const assert=require('node:assert/strict'),{randomUUID}=require('node:crypto')
async function main(args){
 assert.deepEqual(args,['--rollback']);require('../src/config/loadEnv')
 const {PrismaClient}=require('@prisma/client'),pooled=new URL(process.env.DATABASE_URL),direct=new URL(process.env.DIRECT_URL)
 assert.equal(pooled.hostname,direct.hostname);assert.equal(pooled.username,direct.username);assert.equal(pooled.pathname,direct.pathname);assert(direct.hostname.endsWith('.supabase.com'))
 const db=new PrismaClient({datasources:{db:{url:direct.toString()}},log:[]}),{rollbackCheckout,quietDiagnostic}=require('../scripts/diagnose-pos-checkout')
 let phase='setup',saleId
 try{
  const {value}=await quietDiagnostic(async()=>{
   const quote=await db.commercialDocument.findFirst({where:{doc_type:'QUOTE',status:'ACCEPTED',documentSales:{none:{}},convertedChildren:{none:{doc_type:'ORDER'}},quoted_engagement:null,customerContact:{party_type:'CUSTOMER',deleted:false,estado:1},branch:{active:true,company:{active:true}},lines:{some:{}}},orderBy:{created_at:'desc'},select:{id:true,total:true,branch_id:true,branch:{select:{company_id:true}}}})
   assert(quote,'No eligible existing accepted quotation for rollback diagnostic')
   const user=await db.user.findFirst({where:{role:{name:'admin',system_key:'ADMIN',company_id:null}},select:{id:true}});assert(user)
   const scope={companyId:quote.branch.company_id,branchId:quote.branch_id,userId:user.id,isAdmin:true,permissions:[]},api=require('../src/modules/quotes/saleDraft'),manual=require('../src/modules/sales/manualSales')
   const result=await rollbackCheckout(db,async tx=>{
    const boundary=new Proxy(tx,{get:(target,key)=>key==='$transaction'?run=>run(tx):target[key]})
    const effects=async id=>Promise.all([tx.stockMovement.count({where:{ref_id:id}}),tx.salePaymentEntry.count({where:{sale_id:id}}),tx.saleDte.count({where:{sale_id:id}}),tx.journalEntry.count({where:{source_type:'SALE',source_id:id}})])
    phase='convert';const draft=await api.createQuoteSaleDraft(boundary,scope,quote.id);saleId=draft.id
    assert.equal(draft.status,'DRAFT');assert.equal(draft.total,quote.total.toFixed(2));assert.equal(draft.originQuote.id,quote.id);assert.deepEqual(await effects(saleId),[0,0,0,0])
    const persisted=await tx.sale.findUnique({where:{id:saleId}});assert.equal(persisted.payment_method_id,null);assert.equal(persisted.cash_register_session_id,null)
    phase='replay';const replay=await api.createQuoteSaleDraft(boundary,scope,quote.id);assert.equal(replay.id,saleId)
    assert.equal(await tx.commercialDocumentSale.count({where:{document_id:quote.id}}),1)
    phase='foreign-scope';await assert.rejects(manual.readManualSale(boundary,{...scope,companyId:randomUUID()},saleId),{code:'NOT_FOUND'})
    phase='cancel';const cancelled=await manual.cancelManualSale(boundary,scope,saleId,{expectedVersion:1,idempotencyKey:randomUUID()});assert.equal(cancelled.status,'CANCELLED');assert.deepEqual(await effects(saleId),[0,0,0,0])
    assert.equal(await tx.stockReservation.count({where:{document_id:quote.id,status:'ACTIVE'}}),0)
    return{draftWithoutEffects:true,sameSaleOnReplay:true,totalPreserved:true,foreignScopeDenied:true,cancelReleasesReservations:true}
   })
   phase='verify-rollback';assert.equal(await db.sale.count({where:{id:saleId}}),0);assert.equal(await db.commercialDocumentSale.count({where:{sale_id:saleId}}),0)
   return{...result,rolledBack:true}
  });console.log(JSON.stringify(value))
 }catch(e){e.phase=phase;throw e}finally{await db.$disconnect()}
}
if(require.main===module)main(process.argv.slice(2)).catch(e=>{console.error(JSON.stringify({status:'error',phase:e.phase,name:e.name,code:/^(?:P\d{4}|[A-Z_]{3,50})$/.test(e.code||'')?e.code:'INTEGRATION_CHECK_FAILED',argument:/Unknown (?:argument|field) `([\w]+)`|Argument `([\w]+)`/.exec(e.message)?.slice(1).filter(Boolean),frames:e.stack?.split('\n').filter(l=>l.trim().startsWith('at ')&&!l.includes('node_modules')).slice(0,4).map(l=>l.trim())}));process.exitCode=1})
