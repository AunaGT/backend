const test=require('node:test')
const assert=require('node:assert/strict')
const {selectLines}=require('../src/modules/orders/fulfillment')
const {pendingLineQty,isOrderFullyFulfilled,resolveFulfillmentLines}=require('../src/services/commercialDocumentFulfillment')
const line={id:'l',product_id:'s',item_kind:'SERVICE',item_name:'Asesoría',unit_label:'Hora',quantity_decimals:2,qty:'2.5',qty_fulfilled:'1.25',qty_invoiced:'0',unit_price:'100'}
test('partial invoices allocate cumulative cents instead of rounding each fraction independently',()=>{
  const {partialLineTotal}=require('../src/services/commercialDocumentFulfillment')
  const original={...line,qty:'1',unit_price:'19.99',line_total:'19.99'}
  assert.equal(partialLineTotal(original,'0.5','0').toString(),'10')
  assert.equal(partialLineTotal(original,'0.5','0.5').toString(),'9.99')
  assert.equal(partialLineTotal({...original,unit_price:'0.01',line_total:'0.01'},'0.5','0.5').toString(),'0')
})
test('partial service fulfillment and invoicing respect historical precision and exact remaining balances',()=>{
  assert.equal(String(selectLines([line],[{line_id:'l',qty:'1.25'}])[0].qty),'1.25')
  assert.equal(String(selectLines([line],[{line_id:'l',qty:'1.25'}],true)[0].qty),'1.25')
  assert.throws(()=>selectLines([line],[{line_id:'l',qty:'1.26'}]),/pendiente/i)
  assert.throws(()=>selectLines([line],[{line_id:'l',qty:'1.001'}]),/decimal/i)
  assert.throws(()=>resolveFulfillmentLines([line],[{line_id:'l',qty:'1'},{line_id:'l',qty:'1'}]),/repetida|duplicada/i)
  assert.equal(String(pendingLineQty({...line,qty:'0.3',qty_fulfilled:'0.2'})),'0.1')
  assert.equal(isOrderFullyFulfilled([{...line,qty_fulfilled:'2.5'}]),true)
})
test('a confirmed service order invoices delivered fractions with historical units even while services are disabled',async()=>{
  const {invoice}=require('../src/modules/orders/fulfillment')
  let stored=null,writes=0
  const order={id:'o',branch_id:'B',fulfillment_mode:'SEPARATE',status:'PARTIALLY_FULFILLED',lines:[{...line,qty:'1',qty_fulfilled:'1',qty_invoiced:'0.5',unit_price:'19.99',line_total:'19.99'}]}
  const tx={appointmentEngagement:{findFirst:async()=>null},$queryRaw:async()=>[{id:'o'}],$executeRaw:async()=>1,commercialDocument:{findUnique:async()=>order},
    sale:{findFirst:async()=>stored,create:async({data})=>{writes++;stored={id:'v',...data,orderLink:{document_id:'o'}};return stored}},
    paymentMethod:{findUnique:async()=>({id:1,is_credit:false})},saleStatus:{findFirst:async()=>({id:1})},branch:{findUnique:async()=>({id:'B',code:'QA',seq:1})},
    orderDeliveryLine:{findMany:async()=>[{id:'d',document_line_id:'l',qty:'1',qty_invoiced:'0.5',unit_cost:0}],update:async()=>({})},commercialDocumentLine:{update:async()=>({})},systemSetting:{findUnique:async()=>({value:'false'})}}
  const req={companyId:'A',branchId:'B',params:{id:'o'},user:{sub:'U'},body:{request_key:'b73abc4a-041e-4ce0-baa6-d38cc18aaeee',payment_method_id:1,lines:[{line_id:'l',qty:'0.5'}]}}
  const result=await invoice(tx,req,async()=> 'CS')
  assert.equal(result.sale.items,0)
  assert.equal(result.sale.total,9.99)
  assert.equal(result.sale.sale_items.create[0].net_total,9.99)
  assert.equal(result.sale.sale_items.create[0].unit_label,'Hora')
  assert.equal(result.sale.sale_items.create[0].unit_cost,0)
  assert.equal(String(result.sale.sale_items.create[0].qty),'0.5')
  assert.equal((await invoice(tx,req,async()=>assert.fail('No second cash check'))).sale.id,'v')
  assert.equal(writes,1)
})
