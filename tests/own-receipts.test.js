const test=require('node:test'),assert=require('node:assert/strict')
const {withMocks}=require('./helpers/reportHarness.cjs')
const {Prisma}=require('@prisma/client')
const P='00000000-0000-4000-8000-000000000001',R='00000000-0000-4000-8000-000000000002'
const scope={companyId:'A',branchId:'B',userId:'U'}
function fixture(){
  const state={products:[{id:P,company_id:'A',name:'Terminado',kind:'STANDARD',quantity_decimals:0,stock:'2',cost:'1'},{id:R,company_id:'A',name:'Material',kind:'STANDARD',quantity_decimals:3,stock:'10',cost:'4.5'}],receipts:[],items:[],moves:[],valuations:[]}
  const db={branch:{findFirst:async()=>({id:'B'})},$executeRaw:async()=>0,product:{findMany:async()=>state.products,update:async({where,data})=>Object.assign(state.products.find(p=>p.id===where.id),data)},incomingMerchandise:{findFirst:async({where})=>state.receipts.find(r=>r.request_key===where.request_key),create:async({data})=>{const row={id:'receipt',...data};state.receipts.push(row);return row},update:async({where,data})=>Object.assign(state.receipts.find(r=>r.id===where.id),data)},incomingMerchandiseItem:{create:async({data})=>{state.items.push(data);return data}},purchaseLog:{create:async({data})=>state.valuations.push(data)},productLot:{create:async()=>({})},stockLocation:{findFirst:async()=>({id:'LOC'})}}
  const change=async(_tx,map,_branch,ctx,sign)=>{for(const[id,qty]of map){const p=state.products.find(p=>p.id===id),stock=new Prisma.Decimal(p.stock).add(new Prisma.Decimal(qty).mul(sign));if(stock.lt(0))throw Object.assign(Error('Stock insuficiente'),{status:409});p.stock=stock.toFixed();state.moves.push({id,qty:String(qty),sign,ctx})}return[]}
  const mocks={
    [require.resolve('../src/services/stockAvailability')]:{getAvailabilityBatch:async()=>Object.fromEntries(state.products.map(p=>[p.id,{available:new Prisma.Decimal(p.stock).sub(state.reserved||0).toFixed()}]))},
    [require.resolve('../src/modules/inventory/units')]:{lockCompany:async()=>{},advancedProduct:()=>false},
    [require.resolve('../src/services/stockLocations')]:{defaultLocationId:async()=> 'LOC'},
    [require.resolve('../src/services/bomStock')]:{deductStockMap:(...args)=>change(...args,-1),restoreStockMap:(...args)=>change(...args,1)},
  }
  const transaction=async run=>{const before=structuredClone(state);try{return await run(db)}catch(e){Object.assign(state,before);throw e}}
  const input={source:'PRODUCTION',request_key:'production-1',items:[{product_id:P,quantity:'3'}],components:[{product_id:R,quantity:'2'}],costs:{materials:'2',labor:'3',other:'1'}}
  return {state,db,mocks,transaction,input}
}
async function run(f,check){await withMocks(f.mocks,require.resolve('../src/services/ownReceipts'),service=>check(input=>f.transaction(tx=>service.registerOwnReceipt(tx,scope,input))))}
test('production values actual materials plus declared costs, consumes inputs and credits the output once',async()=>{
  const f=fixture();await run(f,async post=>{const result=await post(f.input);assert.equal(result.incomingMerchandise.supplier_id,null);assert.equal(result.totalPurchaseValue,'15.00');assert.equal(f.state.items[0].unit_cost,'5.000000000000');assert.equal(f.state.products[0].cost,'3.400000000000');assert.equal(f.state.products[1].stock,'8');assert.equal(f.state.products[0].stock,'5');assert.equal(f.state.moves[0].ctx.consumeLots,true);assert.equal(f.state.moves[0].ctx.reason,'PRODUCTION');assert.equal(f.state.receipts[0].production_details.components[0].value,'9.00')})
})
test('own initial entry contributes to existing opening reports, never to purchases or payments',async()=>{
  const f=fixture();await run(f,async post=>{const result=await post({source:'INITIAL',request_key:'initial-1',items:[{product_id:P,quantity:'2',unit_cost:'6'}]});assert.equal(result.totalPurchaseValue,'12.00');assert.equal(f.state.moves[0].ctx.reason,'INITIAL');assert.equal(f.state.receipts[0].supplier_id,null);assert.equal(f.state.receipts[0].payment_term_id,undefined);assert.equal(f.state.receipts[0].paid_at,undefined);assert.equal(f.state.valuations[0].source,'INITIAL');assert.equal(f.state.valuations[0].line_total,'12.00');assert.equal(f.state.valuations[0].supplier_id,null)})
})
test('initial stock accepts the existing derived twelve-place cost without changing it to six',async()=>{
  const f=fixture();await run(f,async post=>{await post({source:'INITIAL',request_key:'initial-precision',items:[{product_id:P,quantity:'3',unit_cost:'3.333333333333'}]});assert.equal(f.state.items[0].line_total,'10.00')})
})
test('lost-response retry returns the original document and changed payload cannot reuse its key',async()=>{
  const f=fixture();await run(f,async post=>{const first=await post(f.input),second=await post(structuredClone(f.input));assert.deepEqual(second,first);assert.equal(f.state.moves.length,2);assert.equal(f.state.receipts.length,1);await assert.rejects(post({...f.input,notes:'different'}),e=>e.status===409);assert.equal(f.state.moves.length,2)})
})
test('own entries reject payment and supplier fields rather than hiding a payable',async()=>{
  for(const patch of [{supplier_id:'external'},{payment_status:'PAID'},{payment_method_id:1}]){const f=fixture();await run(f,async post=>{await assert.rejects(post({...f.input,...patch}),e=>e.status===400);assert.equal(f.state.moves.length,0)})}
})
test('production rejects foreign, service, kit, repeated and self-consuming components',async()=>{
  for(const modify of [f=>f.state.products[1].company_id='foreign',f=>f.state.products[1].kind='SERVICE',f=>f.state.products[1].kind='KIT',f=>f.input.components.push({...f.input.components[0]}),f=>f.input.components[0].product_id=P]){const f=fixture();modify(f);await run(f,async post=>{await assert.rejects(post(f.input),e=>[400,404].includes(e.status));assert.equal(f.state.moves.length,0)})}
})
test('insufficient materials or missing expiry roll back the receipt, materials and output together',async()=>{
  for(const modify of [f=>f.input.components[0].quantity='11',f=>f.state.products[0].tracks_expiry=true]){const f=fixture();modify(f);const before=structuredClone(f.state);await run(f,async post=>{await assert.rejects(post(f.input),e=>[400,409].includes(e.status));assert.deepEqual(f.state,before)})}
})
test('output quantity follows its base-unit precision and costs cannot be negative',async()=>{
  for(const patch of [{items:[{product_id:P,quantity:'0.5'}]},{costs:{labor:'-1'}},{items:[{product_id:P,quantity:'0'}]}]){const f=fixture();await run(f,async post=>{await assert.rejects(post({...f.input,...patch}),e=>e.status===400);assert.equal(f.state.receipts.length,0)})}
})
test('production cannot consume material reserved for another operation',async()=>{
  const f=fixture();f.state.reserved=9
  await run(f,async post=>{await assert.rejects(post(f.input),e=>e.status===409);assert.equal(f.state.moves.length,0)})
})
