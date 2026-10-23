const test=require('node:test'),assert=require('node:assert/strict')
const {withMocks,jsonResponse}=require('./helpers/reportHarness.cjs'),{commerceHarness}=require('./helpers/unitsCommerceHarness.cjs')
const model=require.resolve('../src/models/prisma'),target=require.resolve('../src/modules/sales/controller'),reference=require.resolve('../src/services/referenceGenerator')
function fixture(){const p={id:'P',company_id:'A',name:'Producto',kind:'STANDARD',deleted:false,available_for_sale:true,quantity_decimals:0,unit_metadata_version:2,base_unit_id:'UNIT',unit_revision:1,price:'2',cost:'1'};const f=commerceHarness({products:[p],stock:{P:'10'},locations:{'P|L':'10'},units:[{id:'UNIT',company_id:'A',code:'UNIT',name:'Unidad',label:'ud'}]});let committed=false;const queries=[],transaction=f.tx.$transaction,read=f.tx.sale.findFirst,query=f.tx.$queryRaw
 f.tx.$queryRaw=(sql,...args)=>String(sql).includes('pg_advisory_xact_lock')?Promise.resolve([]):query(sql,...args)
 f.tx.$transaction=async run=>{const value=await transaction(run);committed=true;return value}
 f.tx.sale.findFirst=async args=>{queries.push(args);return read(args)}
 return{...f,queries,isCommitted:()=>committed,req:{companyId:'A',branchId:'B',query:{response:'confirmation'},user:{sub:'U',permissions:['sales.create']},body:{idempotency_key:'attempt',payment_method_id:1,cash_register_id:'C',items:[{product_id:'P',qty:'1',presentation_id:null,unit_revision:1}]}}}
}
async function run(f,callback){return withMocks({[model]:{prisma:f.tx,prismaTransaction:f.tx},[reference]:{nextDocumentReference:async()=> 'V-QA-1'}},target,callback)}
test('compact POS confirms only after the real sale transaction and never loads a detail DTO',async()=>{
 const f=fixture()
 await run(f,async sales=>{const response=jsonResponse(),json=response.json.bind(response);response.json=body=>{assert.equal(f.isCommitted(),true);return json(body)}
  await sales.create(f.req,response,e=>{throw e});assert.equal(response.statusCode,201);assert.deepEqual(response.body,{id:'V0',checkout_state:'CONFIRMED'})
  assert.equal(f.state.stock.P,'9');assert.equal(f.state.sales.length,1);assert.equal(f.queries.some(q=>q.include),false)
  const replay=jsonResponse();await sales.create(f.req,replay,e=>{throw e});assert.equal(replay.statusCode,200);assert.equal(replay.body.id,'V0');assert.equal(f.state.sales.length,1);assert.equal(f.state.stock.P,'9')
  assert.equal(f.queries[0].where.branch.company_id,'A')
 })
})
test('legacy sale response retains its full detail and post-commit failure remains confirmed',async()=>{
 const f=fixture();f.req.query={}
 await run(f,async sales=>{const res=jsonResponse();await sales.create(f.req,res,e=>{throw e});assert.equal(res.statusCode,201);assert.equal(res.body.sale_items.length,1);assert.ok(f.queries.some(q=>q.include))})
 const failed=fixture();failed.req.query={};const read=failed.tx.sale.findFirst;failed.tx.sale.findFirst=args=>args.where.id?Promise.reject(Error('detail offline')):read(args)
 await run(failed,async sales=>{const res=jsonResponse();await sales.create(failed.req,res,e=>{throw e});assert.equal(res.statusCode,202);assert.equal(res.body.checkout_state,'CONFIRMED');assert.equal(failed.state.sales.length,1)})
})
test('compact replay preserves hash and actor checks and an unknown response option cannot mutate',async()=>{
 const f=fixture();await run(f,async sales=>{
  await sales.create(f.req,jsonResponse(),e=>{throw e})
  for(const req of [{...f.req,user:{...f.req.user,sub:'other'}},{...f.req,body:{...f.req.body,amount_received:999}}]){let error;await sales.create(req,jsonResponse(),e=>{error=e});assert.equal(error?.status,409)}
  const response=jsonResponse();await sales.create({...f.req,query:{response:'anything'}},response,e=>{throw e});assert.equal(response.statusCode,400);assert.equal(f.state.sales.length,1)
 })
})
test('compact unique-key race recovers the original committed sale without loading detail or deducting again',async()=>{
 const f=fixture();await run(f,async sales=>{
  await sales.create(f.req,jsonResponse(),e=>{throw e})
  const read=f.tx.sale.findFirst;let first=true
  f.tx.sale.findFirst=async args=>{if(first){first=false;return null}return read(args)}
  f.tx.$transaction=async()=>{throw Object.assign(Error('race'),{code:'P2002',meta:{target:['branch_id','idempotency_key']}})}
  const res=jsonResponse();await sales.create(f.req,res,e=>{throw e});assert.equal(res.statusCode,200);assert.deepEqual(res.body,{id:'V0',checkout_state:'CONFIRMED'});assert.equal(f.state.stock.P,'9');assert.equal(f.state.sales.length,1);assert.equal(f.queries.some(q=>q.include),false)
 })
})
