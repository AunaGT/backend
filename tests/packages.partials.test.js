const test=require('node:test'),assert=require('node:assert/strict')
const {agreementFixture}=require('./helpers/packageAgreementFixture')
const Packages=require('../src/services/commercialPackages')
const {partialLineTotal,netDocumentLines}=require('../src/services/commercialDocumentFulfillment')
const {id}=require('./helpers/packageFixtures')
async function single(){
  const f=await agreementFixture(),definition=f.state.versions[0].definition
  f.state.products.find(p=>p.id===id(20)).quantity_decimals=1
  definition.variants[0].components[0].quantity='1';definition.variants[0].components[0].weight='1'
  definition.variants[0].choices=[];definition.variants[0].price='19.99'
  return{...f,...await Packages.buildPackageGroups(f.db,f.scope,[{...f.selection(),choices:[]}],{allowIncomplete:true})}
}
test('partial invoices allocate 19.99 as 10.00 then 9.99 and preserve original group as reference',async()=>{
  const f=await single(),source=f.lines[0]
  const first=partialLineTotal(source,'0.5','0').toFixed(2),last=partialLineTotal(source,'0.5','0.5').toFixed(2)
  assert.deepEqual([first,last],['10.00','9.99'])
  for(const amount of [first,last])Packages.assertPackageAgreement({package_groups:f.groups,sale_items:[{...source,qty:'0.5',base_qty:'0.5',price:source.unit_price,net_total:amount}],total:amount},{kind:'SALE',allowPartial:true})
  assert.throws(()=>Packages.assertPackageAgreement({package_groups:f.groups,sale_items:[{...source,qty:'0.5',base_qty:'0.5',price:source.unit_price,net_total:'19.99'}],total:'19.99'},{kind:'SALE',allowPartial:true}),{code:'PACKAGE_REVIEW_REQUIRED'})
})
test('global discount affects package and free product once, including legacy unit lines',async()=>{
  const f=await single(),component={...f.lines[0],unit_price:'100',line_total:'100.00'},groups=structuredClone(f.groups)
  Object.assign(groups[0],{amount:'100.00',estimatedAmount:'100.00',netAmount:'100.00'})
  Object.assign(groups[0].components[0],{unitPrice:'100',lineTotal:'100.00',netLineTotal:'100.00'})
  const lines=[component,{product_id:id(21),qty:'1',unit_price:'100',line_total:'100.00'}]
  const finalized=Packages.finalizePackageAmounts(groups,lines,{documentTotal:'180.00'}),document={package_groups:finalized,lines,total:'180.00'}
  const net=netDocumentLines(document)
  assert.equal(finalized[0].netAmount,'90.00');assert.deepEqual(net.map(l=>l.line_total.toFixed(2)),['90.00','90.00'])
  assert.deepEqual(netDocumentLines({...document,lines:net}).map(l=>l.line_total.toFixed(2)),['90.00','90.00'])
  Packages.assertPackageAgreement({package_groups:finalized,sale_items:net.map(l=>({...l,price:l.unit_price,net_total:l.line_total})),total:'180.00'},{kind:'SALE'})
})
test('full sale cannot omit a component or silently change its net allocation',async()=>{
  const f=await agreementFixture(),out=await Packages.buildPackageGroups(f.db,f.scope,[f.selection()],{allowIncomplete:true})
  const lines=out.lines.map(l=>({...l,price:l.unit_price,net_total:l.line_total}))
  Packages.assertPackageAgreement({package_groups:out.groups,sale_items:lines,total:'1599.00'},{kind:'SALE'})
  assert.throws(()=>Packages.assertPackageAgreement({package_groups:out.groups,sale_items:lines.slice(1),total:'1279.20'},{kind:'SALE'}),{code:'PACKAGE_REVIEW_REQUIRED'})
})
test('real order invoices preserve group on both fractions and do not move stock again',async()=>{
  const {commerceHarness}=require('./helpers/unitsCommerceHarness.cjs'),{randomUUID}=require('node:crypto')
  const f=await single(),source={...f.lines[0],id:id(500),document_id:id(501),qty_fulfilled:'1',qty_invoiced:'0'}
  const h=commerceHarness({products:[],stock:{},locations:{}})
  h.state.documents.push({id:id(501),doc_type:'ORDER',fulfillment_mode:'SEPARATE',status:'FULFILLED',branch_id:'B',package_groups:f.groups,subtotal:'19.99',total:'19.99',discount_total:'0'})
  h.state.documentLines.push(source);h.state.deliveryLines.push({id:'DL',document_line_id:source.id,qty:'1',qty_invoiced:'0',unit_cost:'0'})
  h.tx.appointmentEngagement={findFirst:async()=>null}
  const {invoice}=require('../src/modules/orders/fulfillment')
  const request=()=>({params:{id:id(501)},companyId:'A',branchId:'B',user:{sub:'U'},body:{request_key:randomUUID(),payment_method_id:1,lines:[{line_id:source.id,qty:'0.5'}]}})
  const first=await invoice(h.tx,request(),async()=> 'CS'),last=await invoice(h.tx,request(),async()=> 'CS')
  assert.deepEqual([first.sale.total,last.sale.total],[10,9.99]);assert.equal(h.state.sales.length,2)
  assert.ok(h.state.sales.every(s=>s.package_groups[0].amount==='19.99'))
  assert.ok(h.state.saleItems.every(item=>item.package_component_key===source.package_component_key))
  assert.deepEqual(h.state.movements,[]);assert.equal(h.state.documentLines[0].qty_invoiced,'1')
})
test('partial return uses sold net total even after catalogue price changes',async()=>{
  const {refundFromLine}=require('../src/modules/returns/domain')
  const sold={qty:'1',price:'100.00',net_total:'90.00',package_component_key:id(100)+':'+id(2)}
  const first=refundFromLine({originalQty:sold.qty,lineNet:sold.net_total,qty:'0.5'})
  const last=refundFromLine({originalQty:sold.qty,lineNet:sold.net_total,qty:'0.5',returnedQty:'0.5',returnedAmount:first})
  assert.deepEqual([first,last],[45,45])
})
test('return detail keeps exact original component identity when two groups sold the same product',()=>{
  const {presentReturnDetail}=require('../src/modules/returns/presentation')
  const record={return_items:[{sale_item_id:2,product_id:id(21)}],sale:{sale_items:[{id:1,product_id:id(21),package_component_key:id(100)+':'+id(4)},
    {id:2,product_id:id(21),package_component_key:id(102)+':'+id(4)}]}}
  const detail=presentReturnDetail(record)
  assert.equal(detail.return_items[0].packageComponentKey,id(102)+':'+id(4))
})
