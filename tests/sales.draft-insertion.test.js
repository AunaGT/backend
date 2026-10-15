const test=require('node:test'),assert=require('node:assert/strict')
test('inert insertion preserves snapshot without requiring any stock or payment API',async()=>{
  const {insertSaleRecord}=require('../src/modules/sales/application')
  assert.equal(typeof insertSaleRecord,'function')
  let lines,record
  const tx={sale:{create:async({data})=>{record=data;return {id:'sale-1',...data}}},saleItem:{createMany:async({data})=>{lines=data}}}
  const result=await insertSaleRecord(tx,{saleData:{items:0,subtotal:10,total:10,discount_total:0,payment_method_id:null},items:[{product_id:'p',item_kind:'SERVICE',item_name:'Original',unit_label:'Hora',quantity_decimals:2,qty:0.5,unit_price:20,line_total:10,unit_cost:0}],userId:'u',companyId:'c'})
  assert.equal(result.id,'sale-1');assert.equal(record.payment_method_id,null)
  assert.deepEqual(lines,[{sale_id:'sale-1',product_id:'p',qty:0.5,price:20,unit_cost:0,net_total:10,item_name:'Original',item_kind:'SERVICE',unit_label:'Hora',quantity_decimals:2}])
})
