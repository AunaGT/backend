const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto')
const {withMocks}=require('./helpers/reportHarness.cjs')
const target=require('node:path').resolve(__dirname,'../src/modules/inventory/scanner.js')
function fixture(){const companyId=randomUUID(),branchId=randomUUID(),id=randomUUID();return{scope:{companyId,branchId,user:{sub:randomUUID(),permissions:['sales.create']}},product:{id,company_id:companyId,name:'Agua',barcode:'001234',kind:'STANDARD',deleted:false,available_for_sale:true,price:'5',cost:'2',tracks_expiry:false,unit_revision:3},calls:[]}}
async function run(fn){const h=fixture();h.db={branch:{findFirst:async({where})=>where.id===h.scope.branchId&&where.company_id===h.scope.companyId?{id:where.id}:null},productBarcode:{findFirst:async()=>h.code||null},productPresentation:{findFirst:async()=>h.presentation||null},product:{findMany:async args=>{h.calls.push(args);return h.rows||[h.product]}},productStock:{findMany:async()=>[{product_id:h.product.id,stock:'12',min_stock:'1'}]}}
 await withMocks({[require.resolve('../src/modules/inventory/posCatalog')]:{catalogItemsDTO:async(db,scope,rows)=>rows.map(({cost,company_id,deleted,...p})=>p)}},target,api=>fn(api,h))}
test('scan resolves exact code with leading zeros, no catalogue pagination and no cost for cashier',()=>run(async(api,h)=>{
 const out=await api.resolveScan(h.db,h.scope,{code:'001234',operation:'SALE'});assert.equal(out.product.id,h.product.id);assert.equal(out.product.cost,undefined);assert.equal(out.presentationId,null);assert.equal(h.calls.length,1);assert.equal(h.calls[0].where.company_id,h.scope.companyId);assert.equal(h.calls[0].take,3);assert.deepEqual(h.calls[0].where.OR,[{barcode:'001234'}])
}))
test('operation permissions, unknown code and wrong branch are enforced before returning a product',()=>run(async(api,h)=>{
 await assert.rejects(api.resolveScan(h.db,h.scope,{code:'001234',operation:'PURCHASE'}),{status:403});assert.equal(h.calls.length,0)
 await assert.rejects(api.resolveScan(h.db,{...h.scope,branchId:randomUUID()},{code:'001234',operation:'SALE'}),{status:404})
 h.rows=[];await assert.rejects(api.resolveScan(h.db,h.scope,{code:'001234',operation:'SALE'}),{status:404})
 for(const code of ['',123,'12\n34','1'.repeat(101)])await assert.rejects(api.resolveScan(h.db,h.scope,{code,operation:'SALE'}),{status:400})
}))
test('purchase presentation does not need sale enabled and purchase cost is permission scoped',()=>run(async(api,h)=>{
 h.scope.user.permissions=['products.register_incoming'];h.code={product_id:h.product.id,presentation_id:randomUUID()};h.presentation={id:h.code.presentation_id,active:true,sale_enabled:false,purchase_enabled:true}
 const out=await api.resolveScan(h.db,h.scope,{code:'BOX',operation:'PURCHASE'});assert.equal(out.presentationId,h.code.presentation_id);assert.equal(out.product.cost,'2')
 h.scope.user.permissions=['sales.create'];await assert.rejects(api.resolveScan(h.db,h.scope,{code:'BOX',operation:'SALE'}),{status:409})
}))
test('ambiguous legacy code is never resolved by choosing the first row',()=>run(async(api,h)=>{
 h.rows=[h.product,{...h.product,id:randomUUID()}];await assert.rejects(api.resolveScan(h.db,h.scope,{code:'001234',operation:'SALE'}),{status:409})
}))
