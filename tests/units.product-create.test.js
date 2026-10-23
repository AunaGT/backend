const test=require('node:test')
const assert=require('node:assert/strict')
const units=require('../src/modules/inventory/units')
const {database,scope}=require('./units.catalog.test')

const configuration=()=>({base_unit_id:'kg',quantity_decimals:6,presentations:[{client_key:'saco',name:'Saco',label:'saco',factor:'24',quantity_decimals:0}],default_purchase_key:'saco',default_sale_key:null})
async function createInTransaction(db,state,input){
  const snapshot=structuredClone(state)
  try{
    const data={name:'Café',kind:'STANDARD',stock:0,min_stock:'0',price:'2',...input}
    const finish=await units.prepareProductWrite(db,scope,null,input,data,{create:true})
    Object.assign(state.product,{base_unit_id:null,quantity_decimals:0,unit_revision:1,...data})
    const product=await finish(state.product)
    return {product,data,stock:finish.initialStock}
  }catch(error){Object.assign(state,snapshot);throw error}
}
test('new product saves base, presentations and local defaults in its create transaction',async()=>{
  const {db,state}=database();state.product.base_unit_id=null
  const {product,data,stock}=await createInTransaction(db,state,{units_configuration:configuration(),stock:'0.123456',min_stock:'0.000001'})
  assert.equal(product.base_unit_id,'kg');assert.equal(product.quantity_decimals,6)
  assert.equal(product.presentations[0].factor,'24')
  assert.equal(product.default_purchase_presentation_id,product.presentations[0].id)
  assert.equal(product.default_sale_presentation_id,null)
  assert.equal(stock,'0.123456');assert.equal(data.min_stock,'0.000001')
  assert.equal(data.units_configuration,undefined);assert.equal(state.presentations[0].client_key,undefined)
})
test('initial units are inserted with a new product without querying nonexistent history',async()=>{
  for(const withPresentation of [false,true]){
    const {db,state}=database();state.product.base_unit_id=null
    for(const model of ['saleItem','commercialDocumentLine','purchaseLog','incomingMerchandiseItem','stockMovement','productLot','stockTransferLine','inventoryCountLine','returnItem','returnReplacementItem','orderDeliveryLine','stockReservation','appointmentEngagementLine','appointmentSession','productBomLine','productStock','productStockLocation'])db[model].findFirst=async()=>assert.fail(`New product must not scan ${model}`)
    const config=configuration();if(!withPresentation){config.presentations=[];config.default_purchase_key=null}
    const {product,data}=await createInTransaction(db,state,{units_configuration:config})
    assert.equal(data.base_unit_id,'kg');assert.equal(data.quantity_decimals,6);assert.equal(data.unit_metadata_version,2)
    assert.equal(product.base_unit_id,'kg');assert.equal(product.presentations.length,withPresentation?1:0)
    assert.equal(product.default_purchase_presentation_id,withPresentation?product.presentations[0].id:null)
    if(withPresentation)assert.equal(product.presentations[0].factor,'24')
  }
})
test('failed presentation or unknown default aborts the complete new-product transaction',async()=>{
  for(const modify of [c=>c.presentations[0].factor='0',c=>c.default_sale_key='missing',c=>c.presentations.push({...c.presentations[0]}),c=>c.base_unit_id='foreign']){
    const {db,state}=database();state.product.base_unit_id=null
    const before=structuredClone(state);const config=configuration();modify(config)
    await assert.rejects(createInTransaction(db,state,{units_configuration:config}),e=>[400,404].includes(e.status))
    assert.deepEqual(state,before)
  }
})
test('nested configuration cannot override ownership, revision or a conflicting flat base',async()=>{
  for(const change of [{base_unit_id:'kg'},{unit_revision:1},{units_configuration:{...configuration(),product_id:'foreign'}},{units_configuration:{...configuration(),presentations:[{...configuration().presentations[0],unit_revision:99}]}}]){
    const {db,state}=database()
    await assert.rejects(createInTransaction(db,state,{units_configuration:configuration(),...change}),e=>e.status===400)
  }
})
test('feature-off nested create rejects before new-table access; ordinary legacy create remains intact',async()=>{
  const off={systemSetting:{findUnique:async()=>({key:'inventory_units_enabled',value:'false'})}}
  await assert.rejects(units.prepareProductWrite(off,scope,null,{units_configuration:configuration()},{},{create:true}),e=>e.status===403)
  const finish=await units.prepareProductWrite(off,scope,null,{name:'Legacy'},{name:'Legacy'},{create:true})
  assert.deepEqual(await finish({id:'legacy'}),{id:'legacy'})
})
test('new physical inputs follow the catalog base precision rather than arbitrary draft precision',async()=>{
  for(const [kind,precision,stock] of [['STANDARD',2,'0.001'],['KIT',1,'1']]){
    const {db,state}=database();state.product.base_unit_id=null
    await assert.rejects(createInTransaction(db,state,{kind,stock,units_configuration:{...configuration(),quantity_decimals:precision}}),e=>e.status===400)
  }
})
test('initial precision limits use the normalized kind that will be inserted',async()=>{
  for(const [raw,kind,quantity_decimals] of [['kit','KIT',1],[' kit ','KIT',1],['service','SERVICE',5],[' service ','SERVICE',5]]){
    const {db}=database(),config={...configuration(),quantity_decimals,presentations:[],default_purchase_key:null}
    await assert.rejects(units.prepareProductWrite(db,scope,null,{kind:raw,units_configuration:config},{kind},{create:true}),e=>e.status===400)
  }
})
test('detail-only base lock reports old history at zero stock and any archived presentation',async()=>{
  const {db,state}=database();state.product.stock='0';state.history=true
  assert.equal(await units.productBaseLocked(db,scope,state.product),true)
  state.history=false;assert.equal(await units.productBaseLocked(db,scope,state.product),false)
  state.presentations.push({id:'archived',company_id:'A',product_id:'P',active:false})
  assert.equal(await units.productBaseLocked(db,scope,state.product),true)
  await assert.rejects(units.productBaseLocked(db,{...scope,companyId:'foreign'},state.product),e=>e.status===404)
})
test('ordinary advanced product edits validate manual cost6 and leave unchanged derived12 alone',async()=>{
  const {db,state}=database();state.product.cost='1.123456789012'
  const unchanged={name:'Nuevo'};await units.prepareProductWrite(db,scope,state.product,{name:'Nuevo'},unchanged)
  assert.equal(unchanged.cost,undefined);assert.equal(state.product.cost,'1.123456789012')
  const changed={cost:'1.123456'};await units.prepareProductWrite(db,scope,state.product,{cost:'1.123456'},changed)
  assert.equal(changed.cost,'1.123456')
  await assert.rejects(units.prepareProductWrite(db,scope,state.product,{cost:'1.1234567'},{cost:'1.1234567'}),e=>e.status===400)
})
test('configured product DTO sends tiny derived12 costs as plain decimal strings',async()=>{
  const {db,state}=database(),{Prisma}=require('@prisma/client')
  state.product.cost=new Prisma.Decimal('0.000000000001')
  state.product.stock=new Prisma.Decimal('0.000001')
  const [dto]=await units.extendProductDTO(db,scope,[state.product])
  assert.equal(dto.cost,'0.000000000001');assert.equal(dto.stock,'0.000001');assert.equal(dto.price,'2')
})
test('actual product create freezes measured initial stock only after all configuration; failure rolls back',async()=>{
  const {withMocks,jsonResponse}=require('./helpers/reportHarness.cjs'),{Prisma}=require('@prisma/client')
  for(const [invalid,noSupplier] of [[false,false],[true,false],[false,true]]){
    const {db,state}=database();state.product.base_unit_id=null;state.product.quantity_decimals=0
    state.movements=[];state.purchases=[];state.branch={stock:0,min_stock:0}
    db.product.create=async({data})=>{state.product={id:'P',deleted:false,tracks_expiry:false,quantity_decimals:0,unit_revision:1,...data};return {...state.product}}
    db.product.findUnique=async()=>({...state.product})
    db.product.findMany=async()=>[{...state.product}]
    const update=db.product.update
    db.product.update=async args=>{if(args.data.stock?.increment!==undefined){state.product.stock=new Prisma.Decimal(state.product.stock).add(args.data.stock.increment).toFixed();return {...state.product}}return update(args)}
    db.productCategory={findFirst:async()=>({id:1})};db.supplier={findFirst:async()=>({id:'00000000-0000-0000-0000-000000000001'}),update:async()=>({})}
    db.productStock={...db.productStock,findMany:async()=>[{product_id:'P',...state.branch}],findUnique:async()=>({...state.branch}),update:async({data})=>(state.branch={...state.branch,...data})}
    db.stockMovement={...db.stockMovement,createMany:async({data})=>state.movements.push(...data)}
    db.purchaseLog={...db.purchaseLog,create:async({data})=>{state.purchases.push(data);return data}}
    db.status={findFirst:async()=>null};db.alertType={findMany:async()=>[]};db.alertPriority={findMany:async()=>[]}
    db.$queryRaw=async(sql,...args)=>{if(String(sql).includes('SELECT l.id'))return[{id:'LOC'}];const values=args.flatMap(x=>x?.values||[]);return[{product_id:'P',location_id:'LOC',qty:values[2],balance:'0.123456'}]}
    db.$transaction=async(fn,options)=>{const before=structuredClone(state);try{
      const result=await fn(db)
      // A six-second database round trip must fit the controller's bounded transaction budget.
      if((options?.timeout??5000)<6000)throw Object.assign(new Error('Transaction expired after 5000ms'),{code:'P2028'})
      return result
    }catch(e){Object.assign(state,before);throw e}}
    const config=configuration();if(invalid)config.presentations[0].factor='0'
    await withMocks({[require.resolve('../src/models/prisma')]:{prisma:db,prismaTransaction:db}},require.resolve('../src/modules/inventory/products.controller'),async controller=>{
      const response=jsonResponse(),request={companyId:'A',branchId:'B',user:{sub:'U',permissions:['products.create']},body:{name:'Café',category_id:1,...(noSupplier?{}:{supplier_id:'00000000-0000-0000-0000-000000000001'}),kind:'STANDARD',price:'2',cost:'1.123456',stock:'0.123456',min_stock:'0.000001',units_configuration:config}}
      if(invalid){await assert.rejects(controller.create(request,response,e=>{throw e}),e=>e.status===400);assert.equal(state.product.base_unit_id,null);assert.equal(state.presentations.length,0);assert.equal(state.movements.length,0);assert.equal(state.purchases.length,0)}
      else{await controller.create(request,response,e=>{throw e});assert.equal(response.statusCode,201);assert.equal(response.body.product.base_unit_id,'kg');assert.equal(String(state.branch.stock),'0.123456');assert.equal(state.movements[0].unit_snapshot.version,2);assert.equal(state.movements[0].unit_snapshot.baseUnit.id,'kg');assert.equal(state.purchases[0].base_qty,'0.123456');assert.equal(state.purchases[0].base_unit_cost,'1.123456000000');assert.equal(state.purchases[0].unit_snapshot.baseUnit.decimals,6);if(noSupplier){assert.equal(state.purchases[0].supplier_id,null);assert.equal(state.product.supplier_id,null)}}
    })
  }
})
