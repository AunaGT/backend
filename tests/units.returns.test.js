const test=require('node:test'),assert=require('node:assert/strict')

const snapshot={version:1,entries:[
  {product_id:'C',location_id:'L1',base_qty:'0.1',base_unit_cost:'2',unit_snapshot:{version:2,baseUnit:{decimals:2}},lots:[{qty:'0.1',lot_code:'FIRST',unit_cost:'1',location_id:'L1'}]},
  {product_id:'C',location_id:'L2',base_qty:'0.6',base_unit_cost:'2',unit_snapshot:{version:2,baseUnit:{decimals:2}},lots:[{qty:'0.2',lot_code:'SECOND',unit_cost:'3',location_id:'L2'},{qty:'0.4',lot_code:'THIRD',unit_cost:'4',location_id:'L2'}]},
]}
test('eligible sales expose the frozen base balance instead of subtracting mixed commercial return units',async()=>{
  const {withMocks,jsonResponse}=require('./helpers/reportHarness.cjs')
  const unit={version:2,baseUnit:{id:'U',code:'UNIT',label:'ud',decimals:0},presentation:{id:'BOX',label:'caja',decimals:0},factor:'7'}
  const db={systemSetting:{findUnique:async({where})=>({value:JSON.stringify(where).includes('inventory_units_enabled')?'true':null})},sale:{findMany:async()=>[{id:'V',date:new Date(),total:'10',status:{name:'Completada'},sale_items:[{id:1,qty:'1',price:'10',net_total:'10',base_qty:'7',unit_metadata_version:2,unit_snapshot:unit,
    return_items:[{qty_returned:'1',base_qty:'1',refund_amount:'1.43',return:{status:{name:'Pendiente'}}}]}]}]}}
  await withMocks({[require.resolve('../src/models/prisma')]:{prisma:db,prismaTransaction:db}},require.resolve('../src/modules/returns/controller'),async controller=>{
    const res=jsonResponse();await controller.eligibleSales({companyId:'A',branchId:'B',query:{}},res,e=>{throw e})
    const [line]=res.body.items[0].sale_items
    assert.equal(line.available_base_to_return,'6');assert.equal(String(line.available_to_return),'0.857143')
    assert.equal(line.refundable_amount,8.57);assert.equal(line.unit_snapshot.presentation.id,'BOX')
  })
})
test('eligible sales retain one exact base unit even when its original-box display rounds to zero',async()=>{
  const {withMocks,jsonResponse}=require('./helpers/reportHarness.cjs')
  const unit={version:2,baseUnit:{id:'U',code:'UNIT',label:'ud',decimals:0},presentation:{id:'BOX',label:'caja',decimals:0},factor:'10000000'}
  const db={systemSetting:{findUnique:async({where})=>({key:where.company_id_key.key,value:where.company_id_key.key==='inventory_units_enabled'?'true':null})},sale:{findMany:async()=>[{id:'V',date:new Date(),total:'20',status:{name:'Completada'},sale_items:[
    {id:1,qty:'1',price:'20',net_total:'20',base_qty:'10000000',unit_metadata_version:2,unit_snapshot:unit,return_items:[{qty_returned:'9999999',base_qty:'9999999',refund_amount:'19.99',return:{status:{name:'Pendiente'}}}]},
    {id:2,qty:'1',price:'0',net_total:'0',unit_metadata_version:1,return_items:[{qty_returned:'1',refund_amount:'0',return:{status:{name:'Pendiente'}}}]},
  ]}]}}
  await withMocks({[require.resolve('../src/models/prisma')]:{prisma:db,prismaTransaction:db}},require.resolve('../src/modules/returns/controller'),async controller=>{
    const res=jsonResponse();await controller.eligibleSales({companyId:'A',branchId:'B',query:{}},res,e=>{throw e})
    assert.equal(res.body.totalItems,1)
    assert.equal(res.body.items[0].eligible,true)
    assert.deepEqual(res.body.items[0].sale_items.map(line=>[line.id,line.available_base_to_return,String(line.available_to_return)]),[[1,'1','0']])
  })
})
test('partial physical restoration consumes original locations and lots cumulatively, never the first lot twice',()=>{
  const {slicePhysicalSnapshot}=require('../src/services/units/commercialPhysical')
  const first=slicePhysicalSnapshot(snapshot,'7','1','0')
  assert.deepEqual(first.entries.map(e=>[e.location_id,e.base_qty,e.lots.map(l=>[l.lot_code,l.qty])]),[['L1','0.1',[['FIRST','0.1']]]])
  const next=slicePhysicalSnapshot(snapshot,'7','3','1')
  assert.deepEqual(next.entries.map(e=>[e.location_id,e.base_qty,e.lots.map(l=>[l.lot_code,l.qty])]),[['L2','0.3',[['SECOND','0.2'],['THIRD','0.1']]]])
  assert.deepEqual(slicePhysicalSnapshot(snapshot,'7','3','4').entries.map(e=>e.base_qty),['0.3'])
})
test('an indivisible frozen component cannot be silently rounded during a partial return',()=>{
  const {slicePhysicalSnapshot}=require('../src/services/units/commercialPhysical')
  assert.throws(()=>slicePhysicalSnapshot({version:1,entries:[{...snapshot.entries[0],base_qty:'1',unit_snapshot:{version:1}}]},'7','1','0'),e=>e.status===409&&e.code==='PHYSICAL_SPLIT_NOT_REPRESENTABLE')
})

test('returning one base unit of a box7 keeps its own quantity and frozen base snapshot',()=>{
  const {normalizeReturnLines}=require('../src/modules/returns/domain')
  const original={id:1,product_id:'P',qty:'1',base_qty:'7',price:'10',item_kind:'STANDARD',quantity_decimals:0,unit_metadata_version:2,
    unit_snapshot:{version:2,baseUnit:{id:'U',code:'UNIT',name:'Unidad',label:'ud',decimals:0},presentation:{id:'BOX',version:1,name:'Caja',label:'caja',decimals:0},factor:'7',roundingDelta:'0'}}
  const [line]=normalizeReturnLines([{sale_item_id:1,product_id:'P',qty_returned:'1',presentation_id:null}],[original])
  assert.equal(line.qty_returned,'1');assert.equal(line.base_qty,'1');assert.equal(line.unit_snapshot.presentation,null)
  assert.throws(()=>normalizeReturnLines([{sale_item_id:1,product_id:'P',qty_returned:'1',presentation_id:'LIVE'}],[original]))
})

test('two kits sharing a component receive distinct actual dispatch and lot allocations',()=>{
  const {allocatePhysicalSnapshots}=require('../src/services/units/commercialPhysical')
  const result=allocatePhysicalSnapshots([new Map([['C','0.2']]),new Map([['C','0.5']])],new Map([['C',snapshot.entries]]))
  assert.deepEqual(result.map(s=>s.entries.map(e=>[e.location_id,e.base_qty,e.lots.map(l=>[l.lot_code,l.qty])])),[
    [['L1','0.1',[['FIRST','0.1']]],['L2','0.1',[['SECOND','0.1']]]],
    [['L2','0.5',[['SECOND','0.1'],['THIRD','0.4']]]],
  ])
})

test('a request for three base units after one returned unit reserves cumulative cents on the original box7',async()=>{
  const {withMocks,jsonResponse}=require('./helpers/reportHarness.cjs')
  const unit={version:2,baseUnit:{id:'U',code:'UNIT',name:'Unidad',label:'ud',decimals:0},presentation:{id:'BOX',version:1,name:'Caja',label:'caja',decimals:0},factor:'7',roundingDelta:'0'}
  const original={id:1,product_id:'P',qty:'1',base_qty:'7',price:'10',net_total:'10',item_kind:'STANDARD',quantity_decimals:0,unit_metadata_version:2,unit_snapshot:unit,
    product:{name:'Producto'},return_items:[{qty_returned:'1',base_qty:'1',refund_amount:'1.43',return:{status:{name:'Completada'}}}]}
  const sale={id:'V',date:new Date(),status:{name:'Completada'},branch_id:'B',branch:{id:'B'},total:'10',returns:[{total_refund:'1.43'}],sale_items:[original]}
  let header,items=[]
  const tx={$queryRaw:async()=>[],sale:{findFirst:async()=>sale},systemSetting:{findUnique:async()=>null},returnStatus:{findFirst:async()=>({id:1})},
    return:{create:async({data})=>{header={id:'R',...data};return header}},returnItem:{create:async({data})=>{items.push(data)}}}
  const db={sale:{findFirst:async()=>({id:'V'})},$transaction:async run=>run(tx),return:{findUnique:async()=>header}}
  await withMocks({[require.resolve('../src/models/prisma')]:{prisma:db,prismaTransaction:db},[require.resolve('../src/services/referenceGenerator')]:{nextDocumentReference:async()=> 'D-1'}},
    require.resolve('../src/modules/returns/controller'),async controller=>{
      await controller.create({companyId:'A',branchId:'B',user:{sub:'U'},body:{sale_id:'V',reason:'Garantía',items:[{sale_item_id:1,product_id:'P',qty_returned:'3',presentation_id:null}]}},jsonResponse(),e=>{throw e})
    })
  assert.equal(String(header.total_refund),'4.28');assert.equal(header.unit_metadata_version,2)
  assert.equal(items[0].base_qty,'3');assert.equal(items[0].qty_returned,'3');assert.equal(items[0].unit_snapshot.presentation,null)
})

test('completion accepts a measured return in its own unit and freezes only its remaining original physical slice',()=>{
  const {buildCompletionPlan}=require('../src/modules/returns/application')
  const unit={version:2,baseUnit:{id:'KG',code:'KG',name:'Kilogramo',label:'kg',decimals:2},presentation:null,factor:'1',roundingDelta:'0'}
  const original={id:1,product_id:'C',qty:'0.7',base_qty:'0.7',base_returned:'0.1',item_kind:'STANDARD',unit_metadata_version:2,unit_snapshot:unit,physical_snapshot:snapshot}
  const item={id:2,sale_item_id:1,product_id:'C',qty_returned:'0.3',base_qty:'0.3',unit_metadata_version:2,unit_snapshot:unit}
  const record={status:{name:'Aprobada'},approved_resolution:'REFUND_CASH',total_refund:3,sale:{total:10,total_returned:1,sale_items:[original]},return_items:[item]}
  const plan=buildCompletionPlan(record,{idempotency_key:'R',lines:[{return_item_id:2,received_qty:'0.3',disposition:'SELLABLE',stock_location_id:'L2'}]})
  assert.equal(plan.lines[0].base_received_qty,'0.3');assert.equal(plan.lines[0].base_restock_qty,'0.3')
  assert.deepEqual(plan.lines[0].physical_snapshot.entries.map(e=>[e.location_id,e.base_qty]),[['L2','0.3']])
})

test('legacy direct product attribution uses original movements while ambiguous overlapping kits fail closed',async()=>{
  const {recoverSalePhysicalLine}=require('../src/services/units/commercialPhysical')
  const rows=[{product_id:'P',location_id:'OLD',qty:-2,unit_snapshot:null}]
  const tx={stockMovement:{findMany:async()=>rows},product:{findMany:async()=>[{id:'P',tracks_expiry:false}]}}
  const source={id:1,product_id:'P',qty:2,item_kind:'STANDARD',unit_cost:'3'}
  const recovered=await recoverSalePhysicalLine(tx,{id:'V',sale_items:[source]},source)
  assert.equal(recovered.entries[0].base_qty,'2');assert.equal(recovered.entries[0].location_id,'OLD')
  rows[0].product_id='COMPONENT'
  const kit={...source,product_id:'KIT',item_kind:'KIT'}
  await assert.rejects(recoverSalePhysicalLine(tx,{id:'V',sale_items:[kit,{...kit,id:2,product_id:'KIT2'}]},kit),e=>e.code==='PHYSICAL_SNAPSHOT_REQUIRED')
})

test('exchange approval preserves distinct saved presentations and their prices after archival',async()=>{
  const {commerceHarness}=require('./helpers/unitsCommerceHarness.cjs'),{resolvePricedSaleItems}=require('../src/modules/sales/application'),{approveReturn}=require('../src/modules/returns/application')
  const presentation={id:'BOX',product_id:'P',company_id:'A',active:true,version:1,name:'Caja',label:'caja',quantity_decimals:0,factor:'7',sale_enabled:true,price:'10'}
  const product={id:'P',company_id:'A',kind:'STANDARD',name:'Producto',unit_metadata_version:2,base_unit_id:'U',quantity_decimals:0,unit_revision:2,cost:'1',price:'2',deleted:false,available_for_sale:true}
  const f=commerceHarness({products:[product],stock:{P:'20'},locations:{'P|L':'20'},units:[{id:'U',code:'UNIT',name:'Unidad',label:'ud'}],presentations:[presentation]})
  const replacements=await resolvePricedSaleItems(f.tx,{companyId:'A',branchId:'B',permissions:['returns.manage'],items:[{product_id:'P',qty:'1',presentation_id:'BOX',unit_revision:2},{product_id:'P',qty:'1',presentation_id:null,unit_revision:2}]})
  presentation.active=false;presentation.factor='12';f.state.products[0].price='9999999999'
  let saved
  const current={id:'R',requested_resolution:'EXCHANGE',status:{name:'Pendiente'},return_date:new Date(),total_refund:'12',replacement_items:replacements,
    return_items:[{id:1,sale_item_id:1,product_id:'S',qty_returned:'1'}],sale:{id:'V',branch_id:'B',date:new Date(),status:{name:'Completada'},sale_items:[{id:1,product_id:'S',item_kind:'SERVICE',qty:'1'}]}}
  f.tx.return.findFirst=async()=>current;f.tx.return.update=async()=>current
  f.state.returnItems.push(...current.return_items)
  f.tx.returnReplacementItem={deleteMany:async()=>{},createMany:async({data})=>{saved=data}}
  await approveReturn(f.tx,{id:'R',scope:{branch_id:'B'},companyId:'A',permissions:['returns.manage'],lines:[{return_item_id:1}]})
  assert.deepEqual(saved.map(line=>[line.qty,line.base_qty,line.unit_price,line.unit_label]),[['1','7','10','caja'],['1','1','2','ud']])
})

test('replacement browser prices remain unauthorized with units enabled',async()=>{
  const {commerceHarness}=require('./helpers/unitsCommerceHarness.cjs'),{resolvePricedSaleItems}=require('../src/modules/sales/application')
  const f=commerceHarness({products:[{id:'P',company_id:'A',kind:'STANDARD',unit_metadata_version:2,base_unit_id:'U',quantity_decimals:0,unit_revision:2,cost:'1',price:'2',available_for_sale:true,deleted:false}],stock:{P:'20'},locations:{'P|L':'20'},units:[{id:'U',code:'UNIT',name:'Unidad',label:'ud'}]})
  await assert.rejects(resolvePricedSaleItems(f.tx,{companyId:'A',branchId:'B',permissions:['returns.manage'],items:[{product_id:'P',qty:'1',presentation_id:null,unit_revision:2,unit_price:'0.01'}]}),e=>e.status===400)
})

test('a measured service return advances authoritative base progress without receiving or restoring stock',async()=>{
  const {commerceHarness}=require('./helpers/unitsCommerceHarness.cjs'),{completeReturn}=require('../src/modules/returns/application')
  const unit={version:2,baseUnit:{id:'H',code:'H',name:'Hora',label:'h',decimals:2},presentation:null,factor:'1',roundingDelta:'0'}
  const f=commerceHarness({products:[{id:'S',company_id:'A',kind:'SERVICE',name:'Consulta',cost:'0'}],stock:{S:'0'},locations:{}})
  f.state.sales.push({id:'V',branch_id:'B',status_id:1,customer_contact_id:'C',date:new Date(),total:'10',adjusted_total:'10',total_returned:'0'})
  f.state.saleItems.push({id:1,sale_id:'V',product_id:'S',qty:'1.25',base_qty:'1.25',base_returned:'0',item_kind:'SERVICE',unit_metadata_version:2,unit_snapshot:unit})
  f.state.returns.push({id:'R',sale_id:'V',status_id:2,approved_resolution:'CUSTOMER_CREDIT',total_refund:'2',return_date:new Date(),unit_metadata_version:2})
  f.state.returnItems.push({id:1,return_id:'R',sale_item_id:1,product_id:'S',qty_returned:'0.25',base_qty:'0.25',unit_metadata_version:2,unit_snapshot:unit})
  await completeReturn(f.tx,{id:'R',companyId:'A',scope:{branch_id:'B'},userId:'U',payload:{idempotency_key:'once',lines:[{return_item_id:1}]}})
  assert.equal(f.state.saleItems[0].base_returned,'0.25');assert.equal(f.state.returnItems[0].received_qty,null);assert.equal(f.state.movements.length,0)
})

test('real kit sale freezes component cost and a later cancellation restores original components and lot costs after a BOM edit',async()=>{
  const {commerceHarness}=require('./helpers/unitsCommerceHarness.cjs')
  const {withMocks,jsonResponse}=require('./helpers/reportHarness.cjs')
  const component={id:'C',company_id:'A',kind:'STANDARD',name:'Componente',unit_metadata_version:2,base_unit_id:'KG',quantity_decimals:2,unit_revision:2,cost:'8',price:'2',deleted:false,available_for_sale:true,tracks_expiry:true}
  const kit={id:'K',company_id:'A',kind:'KIT',name:'Kit',unit_metadata_version:2,base_unit_id:'U',quantity_decimals:0,unit_revision:2,cost:'0',price:'10',deleted:false,available_for_sale:true,stock_assembled:false,
    kit_components:[{component_product_id:'C',qty_per_unit:'0.25',component_product:component}]}
  const f=commerceHarness({products:[kit,component],stock:{K:'0',C:'2'},locations:{'C|L1':'0.1','C|L2':'1.9'},units:[{id:'U',code:'UNIT',name:'Unidad',label:'ud'},{id:'KG',code:'KG',name:'Kilogramo',label:'kg'}],
    lots:[{id:'A',product_id:'C',branch_id:'B',location_id:'L1',qty_received:'0.1',qty_remaining:'0.1',lot_code:'A',unit_cost:'5',received_at:new Date('2026-01-01'),expiry_date:null},
      {id:'B',product_id:'C',branch_id:'B',location_id:'L2',qty_received:'1.9',qty_remaining:'1.9',lot_code:'B',unit_cost:'7',received_at:new Date('2026-01-02'),expiry_date:null}]})
  const app=require('../src/modules/sales/application'),{resolveCommercialLines}=require('../src/services/units/saleLines')
  const items=await resolveCommercialLines(f.tx,{companyId:'A',branchId:'B',permissions:['sales.create']},[{product_id:'K',qty:'1',presentation_id:null,unit_revision:2}])
  await f.tx.$transaction(tx=>app.createSaleRecordAndStock(tx,{items,userId:'U',companyId:'A',saleData:{reference:'V0',branch_id:'B',status_id:1,items:1,total:10,adjusted_total:10,total_returned:0,unit_metadata_version:2}}))
  assert.equal(f.state.stock.C,'1.75')
  assert.equal(f.state.saleItems[0].unit_cost,'2');assert.equal(f.state.saleItems[0].base_unit_cost,'2')
  f.state.products[0].kit_components=[{component_product_id:'NOW_DIFFERENT',qty_per_unit:'99'}]
  await withMocks({[require.resolve('../src/models/prisma')]:{prisma:f.tx,prismaTransaction:f.tx}},require.resolve('../src/modules/sales/controller'),async controller=>{
    await controller.updateStatus({companyId:'A',branchId:'B',params:{id:'V0'},user:{sub:'U'},body:{status_id:2}},jsonResponse(),e=>{throw e})
  })
  assert.equal(f.state.stock.C,'2')
  assert.deepEqual(f.state.lots.slice(2).map(l=>[l.location_id,l.qty_remaining,l.unit_cost,l.lot_code]),[['L1','0.1','5','A'],['L2','0.15','7','B']])
})

test('real return completion restores the selected original lots once and advances only base progress',async()=>{
  const {commerceHarness}=require('./helpers/unitsCommerceHarness.cjs')
  const {completeReturn}=require('../src/modules/returns/application')
  const unit={version:2,baseUnit:{id:'KG',code:'KG',name:'Kilogramo',label:'kg',decimals:2},presentation:null,factor:'1',roundingDelta:'0'}
  const f=commerceHarness({products:[{id:'C',company_id:'A',kind:'STANDARD',name:'Componente',unit_metadata_version:2,base_unit_id:'KG',quantity_decimals:2,cost:'999',deleted:false}],
    stock:{C:'1.3'},locations:{'C|L1':'0','C|L2':'1.3'},units:[{id:'KG',code:'KG',name:'Kilogramo',label:'kg'}]})
  f.state.sales.push({id:'V',branch_id:'B',status_id:1,customer_contact_id:'CUSTOMER',date:new Date(),total:'10',adjusted_total:'9',total_returned:'1'})
  f.state.saleItems.push({id:1,sale_id:'V',product_id:'C',qty:'0.7',base_qty:'0.7',base_returned:'0.1',unit_cost:'2',base_unit_cost:'2',item_kind:'STANDARD',unit_metadata_version:2,unit_snapshot:unit,physical_snapshot:snapshot})
  f.state.returns.push({id:'R',sale_id:'V',status_id:2,approved_resolution:'CUSTOMER_CREDIT',total_refund:'3',return_date:new Date(),unit_metadata_version:2})
  f.state.returnItems.push({id:1,return_id:'R',sale_item_id:1,product_id:'C',qty_returned:'0.3',base_qty:'0.3',unit_metadata_version:2,unit_snapshot:unit})
  const params={id:'R',companyId:'A',scope:{branch_id:'B'},userId:'U',payload:{idempotency_key:'once',lines:[{return_item_id:1,received_qty:'0.3',disposition:'SELLABLE',stock_location_id:'L2'}]}}
  await completeReturn(f.tx,params)
  assert.equal(f.state.stock.C,'1.6');assert.equal(f.state.saleItems[0].base_returned,'0.4')
  assert.equal(f.state.returnItems[0].base_received_qty,'0.3');assert.equal(f.state.returnItems[0].base_restock_qty,'0.3')
  assert.deepEqual(f.state.lots.map(l=>[l.lot_code,l.qty_remaining,l.unit_cost]),[['SECOND','0.2','3'],['THIRD','0.1','4']])
  assert.equal((await completeReturn(f.tx,params))._idempotent,true)
  assert.equal(f.state.stock.C,'1.6');assert.equal(f.state.credits.length,1)
})
