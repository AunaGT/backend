// Opt-in, read-only diagnostic against existing development Supabase data.
const assert=require('node:assert/strict')
async function main(args){
 assert.deepEqual(args,['--read-only']);require('../src/config/loadEnv')
 const {PrismaClient}=require('@prisma/client'),pooled=new URL(process.env.DATABASE_URL),direct=new URL(process.env.DIRECT_URL)
 assert.equal(pooled.hostname,direct.hostname);assert.equal(pooled.username,direct.username);assert.equal(pooled.pathname,direct.pathname);assert(direct.hostname.endsWith('.supabase.com'))
 const db=new PrismaClient({datasources:{db:{url:direct.toString()}},log:[]});let phase='setup'
 try{
  const {value}=await require('../scripts/diagnose-pos-checkout').quietDiagnostic(async()=>{
   const stock=await db.productStock.findFirst({where:{branch:{active:true,company:{active:true}},product:{deleted:false,available_for_sale:true,kind:'STANDARD',barcode:{not:null}}},select:{branch_id:true,product:{select:{id:true,barcode:true,company_id:true}}}});assert(stock?.product.barcode)
   const scope={companyId:stock.product.company_id,branchId:stock.branch_id,user:{sub:'diagnostic-read-only',permissions:['sales.create']}},api=require('../src/modules/inventory/scanner')
   phase='sale-read';const sale=await api.resolveScan(db,scope,{code:stock.product.barcode,operation:'SALE'});assert.equal(sale.product.id,stock.product.id);assert.equal(sale.product.cost,undefined)
   phase='purchase-read';const purchase=await api.resolveScan(db,{...scope,user:{...scope.user,permissions:['products.register_incoming']}},{code:stock.product.barcode,operation:'PURCHASE'});assert.equal(purchase.product.id,stock.product.id);assert(purchase.product.cost!=null)
   phase='permission';await assert.rejects(api.resolveScan(db,{...scope,user:{permissions:[]}},{code:stock.product.barcode,operation:'SALE'}),{status:403})
   return{saleExactProduct:true,cashierCostOmitted:true,purchaseExactProduct:true,purchaseCostAuthorized:true,permissionDenied:true,readOnly:true}
  });console.log(JSON.stringify(value))
 }catch(e){e.phase=phase;throw e}finally{await db.$disconnect()}
}
if(require.main===module)main(process.argv.slice(2)).catch(e=>{console.error(JSON.stringify({phase:e.phase,name:e.name,code:/^(?:P\d{4}|[A-Z_]{3,50})$/.test(e.code||'')?e.code:'DIAGNOSTIC_FAILED',argument:/Unknown (?:argument|field) `([\w]+)`|Argument `([\w]+)`/.exec(e.message)?.slice(1).filter(Boolean)}));process.exitCode=1})
