const test=require('node:test'),assert=require('node:assert/strict')
const {documentData}=require('../src/modules/sales/documents/data')
const sale={id:'sale-1',reference:'V-42',date:new Date('2026-10-22T12:00:00Z'),customer:'María',customer_nit:'CF',total:'18.90',adjusted_total:'0.00',subtotal:'20.00',discount_total:'1.10',payment_method:{name:'Efectivo'},branch:{name:'Principal',company:{name:'Café',tax_id:'123'}},sale_items:[{item_name:'Café histórico',unit_metadata_version:2,unit_snapshot:{version:2,baseUnit:{label:'kg'},presentation:null},qty:'0.123456',price:'18.90',net_total:'18.90',base_unit_cost:'4.99'}]}
test('frozen document data uses original persisted totals, names and exact units, never adjusted total or costs',()=>{
  const data=documentData(sale,{})
  assert.equal(data.totals.total,'18.90');assert.equal(data.totals.discount,'1.10')
  assert.equal(data.lines[0].quantity,'0.123456');assert.equal(data.lines[0].unit,'kg');assert.equal(data.lines[0].price,'18.90')
  assert.equal(data.lines[0].name,'Café histórico');assert.equal('base_unit_cost' in data.lines[0],false);assert.equal(data.fiscal,null)
})
test('missing historical item name, unit or totals is rejected without old rendering or catalog reconstruction',()=>{
  for(const change of [s=>s.sale_items[0].item_name='',s=>s.sale_items[0].unit_snapshot=null,s=>s.subtotal=null]) {
    const row=structuredClone(sale);change(row);assert.throws(()=>documentData(row,{}),{code:'DOCUMENT_DATA_INCOMPLETE'})
  }
})
test('unit prices with eighteen decimal places remain exact instead of being rounded or misclassified as legacy',()=>{
  const row=structuredClone(sale);row.sale_items[0].price='1.123456789012345678'
  assert.equal(documentData(row,{}).lines[0].price,'1.123456789012345678')
})
test('receipt records received cash and change only when persisted, without reconstructing either',()=>{
  const data=documentData({...sale,amount_received:'20.00',change:'1.10'})
  assert.equal(data.paymentAtPreparation.received,'20.00');assert.equal(data.paymentAtPreparation.change,'1.10')
  const missing=documentData(sale);assert.equal(missing.paymentAtPreparation.received,undefined);assert.equal(missing.paymentAtPreparation.change,undefined)
})
module.exports={sale}

test('POS null discount means no discount and never redirects a complete sale to the old renderer',()=>{
  const row=structuredClone(sale);row.discount_total=null;row.subtotal='18.90'
  const data=documentData(row)
  assert.equal(data.totals.discount,'0.00');assert.equal(data.totals.total,'18.90')
})
