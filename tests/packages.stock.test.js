const test=require('node:test'),assert=require('node:assert/strict')
const {commerceHarness}=require('./helpers/unitsCommerceHarness.cjs')
const {id}=require('./helpers/packageFixtures')
test('production consumes materials once; package sale consumes finished goods once; service never moves stock',async()=>{
  const finished=id(610),material=id(611),service=id(612),kit=id(613),unit=id(600),location=id(601)
  const products=[{id:finished,company_id:'A',name:'Terminado',kind:'STANDARD',unit_metadata_version:2,base_unit_id:unit,unit_revision:1,quantity_decimals:0,cost:'1',available_for_sale:true,deleted:false},
    {id:material,company_id:'A',name:'Material',kind:'STANDARD',unit_metadata_version:2,base_unit_id:unit,unit_revision:1,quantity_decimals:0,cost:'4.5',available_for_sale:true,deleted:false},
    {id:service,company_id:'A',name:'Atención',kind:'SERVICE',unit_metadata_version:1,service_unit_label:'hora',quantity_decimals:1,cost:'0',available_for_sale:true,deleted:false},
    {id:kit,company_id:'A',name:'Kit existente',kind:'KIT',unit_metadata_version:1,quantity_decimals:0,stock_assembled:false,kit_components:[{component_product_id:material,qty_per_unit:'2'}],available_for_sale:true,deleted:false}]
  products[3].kit_components[0].component_product=products[1]
  const h=commerceHarness({products,stock:{[finished]:'2',[material]:'10'},locations:{[finished+'|'+location]:'2',[material+'|'+location]:'10'},units:[{id:unit,company_id:'A',code:'UNIT',name:'Unidad',label:'ud'}]})
  h.tx.branch.findFirst=async()=>({id:'B'});h.state.receipts=[]
  h.tx.incomingMerchandise={findFirst:async({where})=>h.state.receipts.find(r=>r.request_key===where.request_key),create:async({data})=>{const row={id:id(620),...data};h.state.receipts.push(row);return row},update:async({where,data})=>Object.assign(h.state.receipts.find(r=>r.id===where.id),data)}
  h.tx.incomingMerchandiseItem={create:async({data})=>data}
  h.tx.product.update=async({where,data})=>Object.assign(h.state.products.find(p=>p.id===where.id),data)
  const scope={companyId:'A',branchId:'B',userId:'U'},production={source:'PRODUCTION',request_key:'package-production',location_id:location,
    items:[{product_id:finished,quantity:'3'}],components:[{product_id:material,quantity:'2'}],costs:{materials:'2',labor:'3',other:'1'}}
  const {registerOwnReceipt}=require('../src/services/ownReceipts')
  await registerOwnReceipt(h.tx,scope,production);await registerOwnReceipt(h.tx,scope,production)
  assert.equal(h.state.stock[finished],'5');assert.equal(h.state.stock[material],'8')
  const {moveSaleStock}=require('../src/modules/sales/application')
  const unitSnapshot={version:2,baseUnit:{id:unit,code:'UNIT',name:'Unidad',label:'ud',decimals:0},presentation:null,factor:'1',roundingDelta:'0'}
  await moveSaleStock(h.tx,[{product_id:finished,item_kind:'STANDARD',qty:'1',base_qty:'1',unit_metadata_version:2,unit_snapshot:unitSnapshot,package_component_key:id(100)+':'+id(2)},
    {product_id:service,item_kind:'SERVICE',qty:'0.5',quantity_decimals:1,unit_label:'hora',unit_metadata_version:1,package_component_key:id(100)+':'+id(3)}],'B',{companyId:'A',reason:'SALE',refType:'synthetic',refId:id(621),userId:'U'})
  assert.equal(h.state.stock[finished],'4');assert.equal(h.state.stock[material],'8')
  assert.equal(h.state.movements.filter(m=>m.product_id===service).length,0)
  await moveSaleStock(h.tx,[{product_id:kit,item_kind:'KIT',qty:'1',package_component_key:id(100)+':'+id(4)}],'B',{companyId:'A',reason:'SALE',refType:'synthetic',refId:id(622),userId:'U'})
  assert.equal(h.state.stock[material],'6');assert.equal(h.state.stock[finished],'4')
})
