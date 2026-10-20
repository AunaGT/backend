const test = require('node:test')
const assert = require('node:assert/strict')
const { withMocks } = require('./helpers/reportHarness.cjs')
const model = require.resolve('../src/models/prisma')
const { planConsume, planRestore, recreateLotsFromSnapshot } = require('../src/services/lots')
const { computeKitAvailableFromBom, buildComponentDeductionMap, normalizeBomInput, expandLinesToStockMap } = require('../src/services/bomStock')

test('aggregate bounds retain authorized negative stock but reject an excessive magnitude',async()=>{
 const {assertStockDeltaBounds}=require('../src/services/units/physical')
 const db={productStock:{findMany:async()=>[{product_id:'p',stock:'0'}]}}
 await assertStockDeltaBounds(db,new Map([['p',{stock:'-99999999'}]]),'B',[['p','0.999999']],-1)
 await assert.rejects(assertStockDeltaBounds(db,new Map([['p',{stock:'-99999999'}]]),'B',[['p','1']],-1),e=>e.status===400)
})

test('FEFO splits measured base quantities exactly and recreates their frozen base costs', async () => {
  const lots = [{id:'a',qty_remaining:'0.1'}, {id:'b',qty_remaining:'0.2'}]
  assert.deepEqual(planConsume(lots, '0.3'), {plan:[{lotId:'a',take:'0.1'},{lotId:'b',take:'0.2'}],short:0})
  assert.deepEqual(planRestore([{id:'a',qty_received:'0.3',qty_remaining:'0.1'}], '0.2'), [{lotId:'a',give:'0.2'}])
  const rows = []
  await recreateLotsFromSnapshot({productLot:{create:async ({data}) => rows.push(data)}}, 'p','b',[
    {lot_code:'A',qty:'0.1',unit_cost:'3.123456789012'}, {lot_code:'B',qty:'0.2',unit_cost:'4'}
  ],'0.3','l')
  assert.deepEqual(rows.map(r => [r.qty_received,r.qty_remaining,r.unit_cost]), [['0.1','0.1','3.123456789012'],['0.2','0.2','4']])
})

test('automatically created measured lots freeze their base cost at the physical increase',async()=>{
  const {ensureLotForIncrease}=require('../src/services/lots')
  let written
  await ensureLotForIncrease({product:{findUnique:async()=>({kind:'STANDARD',tracks_expiry:true,cost:'3.123456789012'})},productLot:{create:async({data})=>(written=data)}},{productId:'p',branchId:'B',locationId:'LOC',qty:'0.1'})
  assert.equal(written.qty_received,'0.1')
  assert.equal(written.unit_cost,'3.123456789012')
})

test('measured BOM components remain fractional while finished kits remain whole', () => {
  const bom = [{component_product_id:'kg',qty_per_unit:'0.25'}]
  assert.equal(normalizeBomInput(bom)[0].qty_per_unit, '0.25')
  assert.equal(computeKitAvailableFromBom(bom, {kg:{available:'1.1'}}), 4)
  assert.deepEqual(buildComponentDeductionMap(bom, 3), new Map([['kg','0.75']]))
  assert.throws(() => buildComponentDeductionMap(bom, '1.5'), /decimal|entero/i)
})

test('BOM component precision follows its physical base unit',async()=>{
  const {validateBomComponents}=require('../src/services/bomStock')
  let decimals=0
  const tx={product:{findUnique:async()=>({id:'k',kind:'KIT',company_id:'A'}),findMany:async()=>[{id:'p',kind:'STANDARD',quantity_decimals:decimals}]}}
  await assert.rejects(validateBomComponents(tx,'k',[{component_product_id:'p',qty_per_unit:'0.25'}]),/decimal/i)
  decimals=6
  assert.equal((await validateBomComponents(tx,'k',[{component_product_id:'p',qty_per_unit:'0.25'}]))[0].qty_per_unit,'0.25')
})

test('kit assembly cannot round a fractional finished quantity into a whole kit',async()=>{
  const {assembleKit}=require('../src/services/bomStock')
  const rows=[{id:'k',kind:'KIT'},{id:'p',kind:'STANDARD',branch_stocks:[{stock:5}]}]
  const tx={product:{findFirst:async()=>({id:'k',kind:'KIT',kit_components:[{component_product_id:'p',qty_per_unit:1}]}),findMany:async({where})=>rows.filter(p=>where.id.in.includes(p.id))},stockReservation:{findMany:async()=>[]},productStock:{findMany:async()=>[{product_id:'p',stock:5}]},$executeRaw:async()=>1,$queryRaw:async()=>assert.fail('Fractional finished kit reached physical writes')}
  await assert.rejects(assembleKit(tx,'k','1.000000000000000001','B'),/decimal/i)
})

test('stock expansion aggregates accepted base quantities from different presentations', async () => {
  const tx={product:{findMany:async()=>[{id:'p',kind:'STANDARD',quantity_decimals:6}]}}
  const out=await expandLinesToStockMap(tx,[{product_id:'p',qty:'2',base_qty:'48',unit_metadata_version:2},{product_id:'p',qty:'0.25',base_qty:'0.25',unit_metadata_version:2}],{companyId:'A'})
  assert.deepEqual(out,new Map([['p','48.25']]))
})

test('dispatch and stock ledger preserve exact fractional deltas and reject an unapproved negative location', async () => {
  const target=require.resolve('../src/services/stockLocations')
  const movements=[]
  const tx={product:{findMany:async()=>[{id:'p',kind:'STANDARD'}]},$executeRaw:async()=>0,
    $queryRaw:async(sql,...args)=>{
      if (String(sql).includes('SELECT psl.product_id')) return [{product_id:'p',location_id:'a',stock:'0.1'},{product_id:'p',location_id:'b',stock:'0.2'}]
      const values=args.flatMap(v=>v?.values||[])
      assert(values.includes('0.3'), 'numeric SQL receives the exact summed delta')
      return [{product_id:'p',location_id:'a',qty:'0.3',balance:'0.3'}]
    },stockMovement:{createMany:async({data})=>movements.push(...data)}}
  await withMocks({[model]:{prisma:tx}},target,async service=>{
    assert.deepEqual(await service.planDispatch(tx,'B',[['p','0.3']]),[{product_id:'p',location_id:'a',qty:'-0.1'},{product_id:'p',location_id:'b',qty:'-0.2'}])
    await service.applyLocationDeltas(tx,[{product_id:'p',location_id:'a',qty:'0.1'},{product_id:'p',location_id:'a',qty:'0.2'}],{branchId:'B'})
    assert.equal(movements[0].qty,'0.3')
    tx.$queryRaw=async()=>[{product_id:'p',location_id:'a',qty:'-0.1',balance:'-0.1'}]
    await assert.rejects(service.applyLocationDeltas(tx,[{product_id:'p',location_id:'a',qty:'-0.1'}],{branchId:'B'}),e=>e.code==='LOCATION_STOCK_MISMATCH')
  })
})

test('availability and transit aggregate Decimal strings without concatenation or binary residue', async()=>{
  const tx={product:{findMany:async()=>[{id:'p',branch_stocks:[{stock:'0.3'}]}]},stockReservation:{findMany:async()=>[{product_id:'p',qty:'0.1'},{product_id:'p',qty:'0.1'}]},stockTransferLine:{findMany:async()=>[{product_id:'p',qty_sent:'0.1'},{product_id:'p',qty_sent:'0.2'}]}}
  const stock=require('../src/services/stockAvailability'),transit=require('../src/services/inTransit')
  assert.deepEqual(await stock.getAvailabilityBatch(['p'],tx,{branchId:'B'}),{p:{stock:'0.3',reserved:'0.2',available:'0.1'}})
  assert.deepEqual(await transit.inTransitByProduct('A',{client:tx}),new Map([['p','0.3']]))
})

test('a reversal recovers frozen component movements without consulting the current BOM',async()=>{
  const service=require('../src/services/bomStock')
  const tx={product:{findMany:async()=>assert.fail('Current BOM must not reinterpret a reversal')},stockMovement:{findMany:async({where})=>{
    assert.equal(where.ref_id,'sale-old')
    assert.equal(where.reason,'SALE')
    return[{product_id:'old-component',qty:'-0.1'},{product_id:'old-component',qty:'-0.15'}]
  }}}
  assert.deepEqual(await service.stockMapFromMovements(tx,{refType:'sale',refId:'sale-old',reason:'SALE'}),new Map([['old-component','0.25']]))
})

test('reservations freeze fractional BOM allocations and consume them after the BOM changes',async()=>{
  const {reserveForDocument,consumePartialByDocument}=require('../src/services/stockAvailability')
  let rows=[]
  const product={id:'k',kind:'KIT',stock_assembled:false,kit_components:[{component_product_id:'old',qty_per_unit:'0.25',component_product:{id:'old',kind:'STANDARD',quantity_decimals:6}}]}
  const line={id:'l',product_id:'k',item_kind:'KIT',qty:4,qty_fulfilled:0}
  const tx={product:{findMany:async()=>[product]},stockReservation:{createMany:async({data})=>{rows=data.map((r,i)=>({id:String(i),...r}))},findMany:async()=>rows,update:async({where,data})=>Object.assign(rows.find(r=>r.id===where.id),data)},commercialDocumentLine:{findUnique:async()=>line,update:async({data})=>{line.qty_fulfilled=new (require('@prisma/client').Prisma.Decimal)(line.qty_fulfilled).add(data.qty_fulfilled.increment)}}}
  await reserveForDocument(tx,{documentId:'d',documentLines:[line],branchId:'B',companyId:'A'})
  assert.equal(String(rows[0].qty),'1')
  product.kit_components=[{component_product_id:'new',qty_per_unit:99}]
  await consumePartialByDocument(tx,'d',[{line_id:'l',qty:1}],{companyId:'A'})
  assert.equal(String(rows[0].qty),'0.75')
  assert.equal(rows[0].product_id,'old')
  assert.equal(String(line.qty_fulfilled),'1')
})

test('integer helper contracts remain numbers and transit value supports report rounding',async()=>{
  const {inTransitTotals}=require('../src/services/inTransit')
  const result=await inTransitTotals('A',[{id:'p',cost:'1.234567890123'}],{client:{stockTransferLine:{findMany:async()=>[{product_id:'p',qty_sent:2}]}}})
  assert.equal(result.units,2)
  assert.equal(result.value.toFixed(2),'2.47')
  assert.deepEqual(buildComponentDeductionMap([{component_product_id:'p',qty_per_unit:2}],3),new Map([['p',6]]))
})

test('actual delivery reversal restores the frozen measured component sum after BOM edits',async()=>{
  const bom=require.resolve('../src/services/bomStock')
  const real=require(bom);let restored
  const order={id:'o',branch_id:'B',fulfillment_mode:'SEPARATE',valid_until:new Date(0),lines:[{id:'l',product_id:'k',item_kind:'KIT',qty:1,qty_fulfilled:1}]}
  const tx={$queryRaw:async()=>[{id:'o'}],commercialDocument:{findUnique:async()=>order,update:async()=>{}},commercialDocumentLine:{update:async()=>{},findMany:async()=>[]},orderDelivery:{findFirst:async()=>({id:'d',lines:[{document_line_id:'l',qty:1,qty_invoiced:0}]}),update:async()=>{}},stockMovement:{findMany:async()=>[{product_id:'old',qty:'-0.1'},{product_id:'old',qty:'-0.15'}]},stockReservation:{updateMany:async()=>{}}}
  await withMocks({[bom]:{...real,restoreStockMap:async(_,map)=>{restored=map;return[]}},[require.resolve('../src/services/lots')]:{restoreLotsFEFO:async()=>{}}},require.resolve('../src/modules/orders/fulfillment'),async c=>{
    await c.reverseDelivery(tx,{companyId:'A',branchId:'B',params:{id:'o',deliveryId:'d'},user:{sub:'U'}})
    assert.deepEqual(restored,new Map([['old','0.25']]))
  })
})

function assemblyFixture({measured=true,enabled=true,shortLots=false}={}) {
  const {Prisma}=require('@prisma/client'),dec=value=>new Prisma.Decimal(value)
  const component={id:'c',company_id:'A',name:'Componente',kind:'STANDARD',unit_metadata_version:measured?2:1,quantity_decimals:measured?6:0,base_unit_id:measured?'kg':null,tracks_expiry:true,cost:'3'}
  const kit={id:'k',company_id:'A',name:'Kit',kind:'KIT',quantity_decimals:0,stock_assembled:false,kit_components:[{component_product_id:'c',qty_per_unit:measured?'0.25':1}]}
  const state={stock:{c:measured?'1':'4',k:'0'},locations:{'c|L1':measured?'0.1':'1','c|L2':measured?'0.9':'3','k|KITLOC':'0'},lots:[
    {id:'a',product_id:'c',location_id:'L1',qty_received:measured?'0.1':'1',qty_remaining:measured?'0.1':'1',lot_code:'A',unit_cost:'2.123456789012',expiry_date:new Date('2027-01-01'),received_at:new Date('2026-01-01')},
    {id:'b',product_id:'c',location_id:'L2',qty_received:measured?'0.9':'3',qty_remaining:shortLots?'0':measured?'0.9':'3',lot_code:'B',unit_cost:'3.987654321012',expiry_date:new Date('2027-02-01'),received_at:new Date('2026-01-01')},
  ],movements:[]}
  let active=false
  const db={
    branch:{findFirst:async()=>({id:'B'})},
    $transaction:async fn=>{const before=structuredClone(state);active=true;try{return await fn(db)}catch(e){Object.assign(state,before);throw e}finally{active=false}},
    $executeRaw:async()=>1,
    $queryRaw:async(sql,...args)=>{
      assert(active,'Physical writes and FEFO must share the caller transaction')
      const s=String(sql),v=args.flatMap(x=>x?.values||[])
      if(s.includes('SELECT l.id'))return[{id:'KITLOC'}]
      if(s.includes('SELECT psl.product_id'))return ['L1','L2'].filter(location=>dec(state.locations['c|'+location]).gt(0)).map(location_id=>({product_id:'c',location_id,stock:state.locations['c|'+location_id]}))
      if(s.includes('UPDATE product_stock_locations')){
        const rows=[];for(let i=0;i<v.length;i+=3){const [product_id,location_id,qty]=v.slice(i,i+3);const key=product_id+'|'+location_id;state.locations[key]=dec(state.locations[key]??0).add(qty).toFixed();rows.push({product_id,location_id,qty,balance:state.locations[key]})}return rows
      }
      if(s.includes('UPDATE product_stocks')){const [id,qty]=v;state.stock[id]=dec(state.stock[id]).add(qty).toFixed();return[{id,name:id,stock:state.stock[id],min_stock:0}]}
      throw Error('Unexpected SQL '+s)
    },
    systemSetting:{findUnique:async({where})=>({key:where.company_id_key.key,value:enabled?'true':'false'})},
    product:{findFirst:async()=>structuredClone(kit),findUnique:async({where})=>where.id==='c'?component:kit,findMany:async({where})=>[component,kit].filter(p=>where.id.in.includes(p.id)&&(!where.tracks_expiry||p.tracks_expiry)).map(p=>({...p,stock:state.stock[p.id],cost:p.cost??'0',branch_stocks:[{stock:state.stock[p.id]}]})),update:async({data})=>{Object.assign(kit,data);return{...kit,stock:state.stock.k,min_stock:0}}},
    productStock:{findMany:async({where})=>where.product_id.in.map(product_id=>({product_id,stock:state.stock[product_id]}))},
    stockReservation:{findMany:async()=>[]},
    measureUnit:{findFirst:async()=>({id:'kg',code:'KG',name:'Kilogramo',label:'kg'})},
    productLot:{findMany:async()=>state.lots.map(l=>({...l})),update:async({where,data})=>{assert(active);const row=state.lots.find(l=>l.id===where.id);row.qty_remaining=dec(row.qty_remaining).sub(data.qty_remaining.decrement).toFixed();return row}},
    stockMovement:{findMany:async({where})=>state.movements.filter(m=>where.group_id?m.group_id===where.group_id:m.ref_id===where.ref_id&&m.ref_type===where.ref_type&&m.reason===where.reason),createMany:async({data})=>{assert(active);state.movements.push(...structuredClone(data))}},
    status:{findFirst:async()=>null},alertType:{findMany:async()=>[]},alertPriority:{findMany:async()=>[]},
  }
  return{db,state,kit,component}
}

test('tracked measured kit assembly consumes actual location FEFO and freezes component allocation costs',async()=>{
  const f=assemblyFixture()
  await withMocks({[model]:{prisma:f.db,prismaTransaction:f.db}},require.resolve('../src/modules/inventory/products.controller'),async controller=>{
    const res=require('./helpers/reportHarness.cjs').jsonResponse()
    await controller.assembleKit({params:{id:'k'},body:{qty:'2'},companyId:'A',branchId:'B',user:{sub:'U'}},res,e=>{throw e})
    assert.equal(f.state.stock.c,'0.5');assert.equal(f.state.stock.k,'2')
    assert.deepEqual(f.state.lots.map(l=>l.qty_remaining),['0','0.5'])
    const out=f.state.movements.filter(m=>m.product_id==='c')
    assert.deepEqual(out.map(m=>[m.location_id,String(m.qty),m.unit_snapshot.baseUnit.code,m.unit_snapshot.lots.map(l=>[l.qty,l.lot_code,l.unit_cost,l.location_id])]),[
      ['L1','-0.1','KG',[['0.1','A','2.123456789012','L1']]],
      ['L2','-0.4','KG',[['0.4','B','3.987654321012','L2']]],
    ])
    assert.equal(new Set(f.state.movements.map(m=>m.group_id)).size,1)
    assert.equal(res.body.assembly_group_id,out[0].group_id)
    assert.match(res.body.assembly_group_id,/^[0-9a-f-]{36}$/)
    const next=require('./helpers/reportHarness.cjs').jsonResponse()
    await controller.assembleKit({params:{id:'k'},body:{qty:'1'},companyId:'A',branchId:'B',user:{sub:'U'}},next,e=>{throw e})
    assert.notEqual(next.body.assembly_group_id,res.body.assembly_group_id)
    assert.equal(f.state.stock.c,'0.25');assert.equal(f.state.stock.k,'3')
    assert.deepEqual(f.state.lots.map(l=>l.qty_remaining),['0','0.25'])
    assert.equal(new Set(f.state.movements.map(m=>m.group_id)).size,2)
    f.kit.kit_components=[{component_product_id:'different',qty_per_unit:99}];f.component.cost='99'
    assert.equal(out[1].unit_snapshot.lots[0].unit_cost,'3.987654321012')
    assert.deepEqual(await require('../src/services/bomStock').stockMapFromMovements(f.db,{groupId:res.body.assembly_group_id}),new Map([['c','0.5']]))
  })
})

for(const enabled of [false,true])test(`legacy kit assembly consumes FEFO with units ${enabled?'enabled and frozen v1 lots':'off and no new JSON columns'}`,async()=>{
  const f=assemblyFixture({measured:false,enabled})
  const out=await f.db.$transaction(tx=>require('../src/services/bomStock').assembleKit(tx,'k','1','B'))
  assert.equal(out.qty,1);assert.equal(f.state.stock.c,'3')
  assert.deepEqual(f.state.lots.map(l=>l.qty_remaining),['0','3'])
  const movement=f.state.movements.find(m=>m.product_id==='c')
  if(enabled){assert.equal(movement.unit_snapshot.version,1);assert.equal(movement.unit_snapshot.lots[0].unit_cost,'2.123456789012')}
  else assert.equal(Object.hasOwn(movement,'unit_snapshot'),false)
})

test('kit assembly with insufficient tracked lots rolls back component stock and never credits finished kits',async()=>{
  const f=assemblyFixture({shortLots:true})
  await withMocks({[model]:{prisma:f.db,prismaTransaction:f.db}},require.resolve('../src/modules/inventory/products.controller'),async controller=>{
    await assert.rejects(controller.assembleKit({params:{id:'k'},body:{qty:'1'},companyId:'A',branchId:'B',user:{sub:'U'}},require('./helpers/reportHarness.cjs').jsonResponse(),e=>{throw e}),e=>e.status===409&&/lote/i.test(e.message))
    assert.deepEqual(f.state.stock,{c:'1',k:'0'})
    assert.deepEqual(f.state.lots.map(l=>l.qty_remaining),['0.1','0'])
    assert.deepEqual(f.state.movements,[])
  })
})
