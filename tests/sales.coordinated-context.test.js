const test=require('node:test'),assert=require('node:assert/strict')
const {Prisma}=require('@prisma/client')
const {resolveCommercialLines}=require('../src/services/units/saleLines')
const Units=require('../src/modules/inventory/units')
const context=()=>{try{return require('../src/services/checkoutContext')}catch(error){if(error.code==='MODULE_NOT_FOUND')return {};throw error}}
const scope={companyId:'A',branchId:'B',actorId:'U',permissions:['sales.create']}
function fixture(count=3){
 const calls=[],products=Array.from({length:count},(_,i)=>({id:`P${i}`,company_id:'A',deleted:false,name:`Product ${i}`,kind:'STANDARD',available_for_sale:true,unit_metadata_version:2,base_unit_id:'UNIT',quantity_decimals:0,unit_revision:3,stock:new Prisma.Decimal('100'),cost:'1.000000000001',price:'2',kit_components:[]}))
 let locked=false
 const unit={id:'UNIT',company_id:'A',code:'UNIT',name:'Unidad',label:'ud',factor:'1'},box={id:'BOX',company_id:'A',product_id:'P0',name:'Caja',label:'caja',factor:'3',active:true,sale_enabled:true,quantity_decimals:0,version:1}
 const db={
  $executeRaw:async(sql,...values)=>{calls.push({method:'lock',sql:String(sql),values});locked=true;return 1},
  product:{findMany:async args=>{assert.equal(args.where.company_id,'A');calls.push({method:'products',args,locked});return products.filter(p=>args.where.id.in.includes(p.id)).map(p=>({...p,unit_revision:locked?p.unit_revision:2}))},findFirst:async()=>{calls.push({method:'singleProduct'});return products[0]}},
  measureUnit:{findMany:async args=>{calls.push({method:'units',args});assert.equal(args.where.company_id,'A');return[unit]},findFirst:async()=>{calls.push({method:'singleUnit'});return unit}},
  productPresentation:{findMany:async args=>{calls.push({method:'presentations',args});assert.equal(args.where.company_id,'A');return[box]},findFirst:async()=>{calls.push({method:'singlePresentation'});return box}},
  systemSetting:{findUnique:async()=>{calls.push({method:'setting'});return {key:'inventory_units_enabled',value:'true'}}},
 }
 return {db,calls,products,unit,box,lines:products.map(p=>({product_id:p.id,qty:'2',presentation_id:null,unit_revision:3}))}
}
for(const count of [1,3,10])test(`coordinated ${count}-product sale resolves exact authoritative unit lines with bounded product/config reads`,async()=>{
 const f=fixture(count),api=context();assert.equal(typeof api.withCheckoutContext,'function')
 const items=[...f.lines,{...f.lines[0],presentation_id:'BOX',qty:'1'}]
 await api.withCheckoutContext(f.db,scope,items,async()=>{
  const lines=await resolveCommercialLines(f.db,scope,items)
  assert.equal(lines.length,count+1);assert.equal(lines[0].unit_price,'2');assert.equal(lines.at(-1).base_qty,'3');assert.equal(lines.at(-1).unit_price,'6')
  assert.equal(lines[0].base_unit_cost,'1.000000000001')
  assert.equal(await Units.unitsEnabled(f.db,'A'),true);assert.equal(await Units.unitsEnabled(f.db,'A'),true)
  assert.equal(f.calls.filter(c=>c.method==='products').length,2)
  assert.equal(f.calls.filter(c=>c.method==='lock').length,1)
  assert.equal(f.calls.filter(c=>c.method==='units').length,1)
  assert.equal(f.calls.filter(c=>c.method==='presentations').length,1)
  assert.equal(f.calls.filter(c=>c.method.startsWith('single')).length,0)
  assert.equal(f.calls.filter(c=>c.method==='setting').length,1)
  const rows=api.checkoutProducts(f.db,['P0'],scope);assert.equal(rows.get('P0').unit_revision,3)
  assert.equal(api.checkoutProducts(f.db,['P0'],{...scope,companyId:'OTHER'}),null)
  assert.equal(api.checkoutProducts(f.db,['P0'],{...scope,branchId:'OTHER'}),null)
  assert.equal(api.checkoutProducts(f.db,['P0'],{...scope,companyId:''}),null)
  assert.equal(api.checkoutProducts(f.db,['P0'],{...scope,branchId:''}),null)
 })
 assert.equal(api.checkoutProducts(f.db,['P0'],scope),null)
})
test('context reflects own stock changes only after branch rows are locked and expires on reused transaction',async()=>{
 const f=fixture(),api=context()
 await api.withCheckoutContext(f.db,scope,f.lines,async()=>{
  assert.equal(api.checkoutBranchRows(f.db,['P0'],'B'),null)
  api.checkoutBranchRows(f.db,['P0'],'B',[{id:'P0',stock:'20'}])
  api.checkoutStockDelta(f.db,[['P0','-3']],'OTHER')
  assert.equal(api.checkoutBranchRows(f.db,['P0'],'B').get('P0').stock,'20')
  api.checkoutStockDelta(f.db,[['P0','-3']],'B')
  assert.equal(api.checkoutBranchRows(f.db,['P0'],'B').get('P0').stock.toFixed(),'17')
  assert.equal(api.checkoutProducts(f.db,['P0'],scope).get('P0').stock.toFixed(),'97')
 })
 f.products[0].stock=new Prisma.Decimal('5')
 await api.withCheckoutContext(f.db,scope,f.lines,async()=>{
  assert.equal(api.checkoutProducts(f.db,['P0'],scope).get('P0').stock.toFixed(),'5')
  assert.equal(api.checkoutBranchRows(f.db,['P0'],'B'),null)
 })
})
test('context disappears after failure and cannot authorize a stale revision or foreign product',async()=>{
 const f=fixture(),api=context();assert.equal(typeof api.withCheckoutContext,'function')
 await assert.rejects(api.withCheckoutContext(f.db,scope,f.lines,()=>resolveCommercialLines(f.db,scope,[{...f.lines[0],unit_revision:2}])),e=>e.code==='UNIT_REVISION_CONFLICT')
 assert.equal(api.checkoutProducts(f.db,['P0'],scope),null)
 await assert.rejects(api.withCheckoutContext(f.db,scope,[{product_id:'FOREIGN',qty:'1'}],()=>resolveCommercialLines(f.db,scope,[{product_id:'FOREIGN',qty:'1'}])),e=>e.status===400||e.status===404)
 assert.equal(api.checkoutProducts(f.db,['P0'],scope),null)
})
test('BOM changes after discovery reject a component that was not included in the sorted locks',async()=>{
 const f=fixture(),api=context();assert.equal(typeof api.withCheckoutContext,'function')
 f.products[0].kind='KIT';const read=f.db.product.findMany;let reads=0
 f.db.product.findMany=async args=>{const rows=await read(args);if(++reads===2)rows[0]={...rows[0],kit_components:[{component_product_id:'NEW',qty_per_unit:'1'}]};return rows}
 await assert.rejects(api.withCheckoutContext(f.db,scope,f.lines,()=>assert.fail('must reject before callback')),e=>e.code==='COMMERCIAL_COMPONENTS_CHANGED')
 assert.equal(api.checkoutProducts(f.db,['P0'],scope),null)
})
test('context requires the company to own the selected branch before lending any product authority',async()=>{
 const f=fixture(),api=context(),read=f.db.product.findMany
 f.db.product.findMany=async args=>args.where.company?.branches?.some?.id==='B'?read(args):[]
 await api.withCheckoutContext(f.db,scope,f.lines,()=>assert(api.checkoutProducts(f.db,['P0'],scope)))
 await assert.rejects(api.withCheckoutContext(f.db,{...scope,branchId:'FOREIGN'},f.lines,()=>assert.fail('must not lend authority')),e=>e.status===404)
 assert.equal(api.checkoutProducts(f.db,['P0'],scope),null)
})
test('assembled kits sell finished stock without requiring or locking their historical components',async()=>{
 const f=fixture(1),api=context();Object.assign(f.products[0],{kind:'KIT',stock_assembled:true,kit_components:[{component_product_id:'NOT_DISPATCHED',qty_per_unit:'2',component_product:{id:'NOT_DISPATCHED',kind:'STANDARD'}}]})
 await api.withCheckoutContext(f.db,scope,f.lines,async()=>{
  const lines=await resolveCommercialLines(f.db,scope,f.lines);assert.equal(lines[0].item_kind,'KIT');assert.equal(lines[0].base_qty,'2')
 })
 assert(!f.calls.find(c=>c.method==='lock').values.flatMap(v=>v?.values||[]).includes('NOT_DISPATCHED'))
})
