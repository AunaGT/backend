const test=require('node:test'),assert=require('node:assert/strict')
const {resolveUnitLine}=require('../src/modules/inventory/units')
const scope={companyId:'A',branchId:'B',permissions:['sales.create','products.register_incoming'],actorId:'U'}
const base={id:'P',company_id:'A',kind:'STANDARD',name:'Tornillo',unit_metadata_version:2,base_unit_id:'u',quantity_decimals:0,unit_revision:3,price:'2.123456',available_for_sale:true,deleted:false}
const unit={id:'u',code:'UNIT',name:'Unidad',label:'ud',quantity_decimals:0,active:true,company_id:'A',factor:'1',family:'COUNT'}
const box={id:'box',company_id:'A',product_id:'P',version:2,name:'Caja',label:'caja',factor:'24',quantity_decimals:0,active:true,sale_enabled:true,purchase_enabled:true,price:null,price_wholesale:'40',price_promotion:null}
function db(product=base,presentation=box){return {$executeRaw:async()=>0,product:{findFirst:async({where})=>where.company_id===product.company_id?product:null},measureUnit:{findFirst:async()=>unit},productPresentation:{findFirst:async({where})=>where.id===presentation?.id&&where.company_id===presentation.company_id&&where.product_id===presentation.product_id?presentation:null}}}
test('server resolves box factor, exact quantity, snapshot and per-tariff override',async()=>{
  const line=await resolveUnitLine(db(),scope,base,{qty:'2',presentation_id:'box',unit_revision:3,price_tier:'WHOLESALE'})
  assert.equal(line.qty,'2');assert.equal(line.base_qty,'48');assert.equal(line.unit_price,'40')
  assert.equal(line.unit_metadata_version,2);assert.equal(line.unit_snapshot.factor,'24');assert.equal(line.unit_snapshot.presentation.version,2)
  assert.equal((await resolveUnitLine(db(),scope,base,{qty:'1',presentation_id:'box',unit_revision:3})).unit_price,'50.962944')
})
test('legacy service keeps its free label, precision and factor one without new models',async()=>{
  const service={id:'S',company_id:'A',name:'Consulta',kind:'SERVICE',quantity_decimals:2,service_unit_label:'Hora',price:'10'}
  const line=await resolveUnitLine({},scope,service,{qty:'1.25'})
  assert.equal(line.base_qty,'1.25');assert.equal(line.unit_metadata_version,1);assert.equal(line.unit_snapshot.factor,'1');assert.equal(line.unit_label,'Hora')
  await assert.rejects(resolveUnitLine({},scope,service,{qty:'1.251'}),e=>e.status===400)
  await assert.rejects(resolveUnitLine({},scope,{...service,kind:'STANDARD'},{qty:'1.25'}),e=>e.status===400)
})
test('stale or absent revisions cannot reinterpret an advanced product as base quantity',async()=>{
  for(const input of [{qty:'2'},{qty:'2',unit_revision:2}])await assert.rejects(resolveUnitLine(db(),scope,base,input),e=>e.status===409)
  for(const extra of [{factor:'1'},{base_qty:'2'},{unit_snapshot:{factor:'1'}}])await assert.rejects(resolveUnitLine(db(),scope,base,{qty:'2',unit_revision:3,...extra}),e=>e.status===400)
})
test('line resolution rejects foreign ownership, operation denial and disabled presentation',async()=>{
  await assert.rejects(resolveUnitLine(db(),{...scope,companyId:'X'},base,{qty:'1',unit_revision:3}),e=>e.status===404)
  await assert.rejects(resolveUnitLine(db(),{...scope,permissions:[]},base,{qty:'1',unit_revision:3}),e=>e.status===403)
  await assert.rejects(resolveUnitLine(db(),scope,base,{qty:'1',unit_revision:3,presentation_id:'foreign'}),e=>e.status===404)
  await assert.rejects(resolveUnitLine(db(base,{...box,sale_enabled:false}),scope,base,{qty:'1',unit_revision:3,presentation_id:'box'}),e=>e.status===400)
})
test('missing selection uses own operation default while explicit null chooses base',async()=>{
  const product={...base,default_sale_presentation_id:'box'}
  assert.equal((await resolveUnitLine(db(product),scope,product,{qty:'1',unit_revision:3})).base_qty,'24')
  assert.equal((await resolveUnitLine(db(product),scope,product,{qty:'1',unit_revision:3,presentation_id:null})).base_qty,'1')
})
test('frozen internal snapshot retains historical factor and validates product scope independently',async()=>{
  const snapshot={version:2,baseUnit:{id:'u',code:'UNIT',name:'Unidad',label:'ud',decimals:0},presentation:{id:'old',version:1,name:'Caja vieja',label:'caja',decimals:0},factor:'7',roundingDelta:'0'}
  const line=await resolveUnitLine(db(),scope,base,{qty:'2'},{snapshot})
  assert.equal(line.base_qty,'14');assert.equal(line.unit_snapshot.factor,'7');assert.deepEqual(snapshot.presentation,line.unit_snapshot.presentation)
  await assert.rejects(resolveUnitLine(db(),{...scope,companyId:'X'},base,{qty:'2'},{snapshot}),e=>e.status===404)
})
test('divisible conversion returns review data and requires explicit rounding acceptance',async()=>{
  const product={...base,quantity_decimals:6};const pound={...box,factor:'0.45359237'}
  const store=db(product,pound);store.measureUnit.findFirst=async()=>({...unit,quantity_decimals:6})
  await assert.rejects(resolveUnitLine(store,scope,product,{qty:'1',unit_revision:3,presentation_id:'box'}),e=>e.code==='QUANTITY_ROUNDING_REQUIRED'&&e.details.baseQty==='0.453592')
  const line=await resolveUnitLine(store,scope,product,{qty:'1',unit_revision:3,presentation_id:'box',accept_rounding:true})
  assert.equal(line.base_qty,'0.453592');assert.equal(line.unit_snapshot.roundingDelta,'-0.00000037')
})
test('persisted tiny Decimal factors stay plain strings rather than exponent notation',async()=>{
  const {Prisma}=require('@prisma/client'),product={...base,quantity_decimals:6},tiny={...box,factor:new Prisma.Decimal('0.000000000001')}
  const store=db(product,tiny);store.measureUnit.findFirst=async()=>({...unit,quantity_decimals:6})
  const line=await resolveUnitLine(store,scope,product,{qty:'1000000',presentation_id:'box',unit_revision:3})
  assert.equal(line.base_qty,'0.000001');assert.equal(line.unit_snapshot.factor,'0.000000000001')
  assert.equal(require('../src/modules/inventory/units').presentationDTO(tiny).factor,'0.000000000001')
})
test('legacy zero alternate tariffs still fall back to list price',async()=>{
  const service={id:'S',company_id:'A',kind:'SERVICE',name:'Consulta',service_unit_label:'Hora',quantity_decimals:2,price:'10',price_wholesale:'0',price_promotion:'0'}
  for(const price_tier of ['WHOLESALE','PROMOTION'])assert.equal((await resolveUnitLine({},scope,service,{qty:'1.25',price_tier})).unit_price,'10')
})
test('large commercial quantities retain exact derived prices until the final money rounding',async()=>{
  const product={...base,price:'1.23',quantity_decimals:6},tiny={...box,factor:'0.0000001'}
  const store=db(product,tiny);store.measureUnit.findFirst=async()=>({...unit,quantity_decimals:6})
  const line=await resolveUnitLine(store,scope,product,{qty:'10000000',presentation_id:'box',unit_revision:3})
  assert.equal(line.base_qty,'1');assert.equal(line.unit_price,'0.000000123');assert.equal(line.line_total,'1.23')
})
test('advanced configuration is read only after taking the product row lock',async()=>{
  const store=db();let locked=false
  store.$executeRaw=async()=>{locked=true}
  store.product.findFirst=async()=>locked?base:{...base,unit_revision:2}
  const line=await resolveUnitLine(store,scope,base,{qty:'2',presentation_id:'box',unit_revision:3})
  assert.equal(line.base_qty,'48')
})
test('enabled units reload a caller legacy product before deciding its unit version',async()=>{
  const stale={...base,unit_metadata_version:1,base_unit_id:null,quantity_decimals:0,unit_revision:1},store=db()
  store.systemSetting={findUnique:async()=>({key:'inventory_units_enabled',value:'true'})}
  await assert.rejects(resolveUnitLine(store,scope,stale,{qty:'1'}),e=>e.status===409&&e.code==='UNIT_REVISION_CONFLICT')
  const resolved=await resolveUnitLine(store,scope,stale,{qty:'1',unit_revision:3,presentation_id:'box'})
  assert.equal(resolved.unit_metadata_version,2);assert.equal(resolved.base_qty,'24')
})
test('an enabled legacy operation takes the row lock and reloads before keeping factor one',async()=>{
  const stale={...base,unit_metadata_version:1,base_unit_id:null,price:'2',quantity_decimals:0},current={...stale,price:'3'},store=db(current)
  store.systemSetting={findUnique:async()=>({key:'inventory_units_enabled',value:'true'})}
  let locked=false;store.$executeRaw=async()=>{locked=true};store.product.findFirst=async()=>locked?current:stale
  const result=await resolveUnitLine(store,scope,stale,{qty:'1'})
  assert.equal(result.unit_price,'3');assert.equal(result.unit_metadata_version,1);assert.equal(result.base_qty,'1')
})
