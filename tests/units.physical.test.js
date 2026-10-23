const test=require('node:test'),assert=require('node:assert/strict')
const {withMocks,jsonResponse}=require('./helpers/reportHarness.cjs')
const {Prisma}=require('@prisma/client')
const model=require.resolve('../src/models/prisma')
// Older physical fixtures start with no branch rows unless the case supplies them.
function branchRows(db){db.productStock??={findMany:async()=>[]};return db}

test('direct product stock SET rejects company overflow under the lock and rolls scalar edits back',async()=>{
 let product={id:'p',kind:'STANDARD',company_id:'A',unit_metadata_version:1,base_unit_id:null,quantity_decimals:0,stock:'99999999',min_stock:0,price:2,cost:1,name:'Original'},branch={stock:0,min_stock:0},locked=false
 const db={systemSetting:{findUnique:async()=>({key:'inventory_units_enabled',value:'false'})},product:{findFirst:async()=>({...product}),findUnique:async()=>({...product}),findMany:async()=>[{...product}],update:async({data})=>(product={...product,...data})},productStock:{findMany:async()=>{assert(locked);return[{product_id:'p',...branch}]},findUnique:async()=>({...branch}),update:async({data})=>(branch={...branch,...data})},$executeRaw:async sql=>{if(String(sql).includes('FOR UPDATE'))locked=true;return 1}}
 db.$transaction=async fn=>{const before={product:{...product},branch:{...branch}};try{return await fn(db)}catch(e){product=before.product;branch=before.branch;throw e}}
 await withMocks({[model]:{prisma:db,prismaTransaction:db}},require.resolve('../src/modules/inventory/products.controller'),async c=>{
  await assert.rejects(c.update({companyId:'A',branchId:'B',params:{id:'p'},user:{sub:'U',permissions:['products.edit']},body:{name:'Changed',stock:2}},jsonResponse(),e=>{throw e}),e=>e.status===400)
  assert.equal(product.name,'Original');assert.equal(product.stock,'99999999');assert.equal(branch.stock,0)
 })
})

test('count start freezes physical unit metadata while holding the product lock',async()=>{
  let written,locked=false
  const product={id:'p',kind:'STANDARD',company_id:'A',unit_metadata_version:2,base_unit_id:'u',quantity_decimals:6,cost:2}
  const session={id:'s',status:'DRAFT',branch_id:'B',scope_json:{},_count:{lines:0}}
  const db={inventoryCountSession:{findFirst:async({where})=>typeof where.id==='string'?session:null,update:async()=>{}},product:{findMany:async()=>[product]},productStock:{findMany:async()=>[{product_id:'p',stock:'0.3'}]},stockLocation:{findMany:async()=>[{id:'LOC',is_default:true,warehouse:{is_default:true}}]},productStockLocation:{findMany:async()=>[{product_id:'p',location_id:'LOC',stock:'0.3'}]},measureUnit:{findFirst:async()=>({id:'u',code:'KG',name:'Kilogramo',label:'kg'})},inventoryCountLine:{createMany:async({data})=>{written=data;assert(locked)}},$executeRaw:async sql=>{if(String(sql).includes('FOR UPDATE'))locked=true;return 1}}
  db.$transaction=async fn=>typeof fn==='function'?fn(db):Promise.all(fn)
  await withMocks({[model]:{prisma:db,prismaTransaction:db}},require.resolve('../src/modules/inventory-count/controller'),async c=>{
    await c.start({companyId:'A',branchId:'B',params:{id:'s'}},jsonResponse(),e=>{throw e})
    assert.equal(written[0].unit_snapshot.baseUnit.code,'KG')
    assert.equal(written[0].unit_snapshot.baseUnit.decimals,6)
    assert.equal(String(written[0].stock_snapshot),'0.3')
  })
})

test('stock alerts compare numeric strings by value and recognize a decimal zero',async()=>{
  const created=[],healthy=[]
  const db={status:{findFirst:async({where})=>({id:where.name})},alertType:{findMany:async()=>[{name:'Sin Stock',id:'zero'},{name:'Stock Bajo',id:'low'}]},alertPriority:{findMany:async()=>[]},alert:{updateMany:async({where})=>healthy.push(...where.product_id.in),findMany:async()=>[],createMany:async({data})=>created.push(...data)}}
  db.$executeRaw=async sql=>{assert.match(String(sql),/pg_advisory_xact_lock/);return 1}
  db.productStock={findMany:async({where})=>{assert.equal(where.branch_id,'B');return[{product_id:'healthy',stock:'10',min_stock:'2'},{product_id:'zero',stock:'0.000000',min_stock:'0.1'}].filter(row=>where.product_id.in.includes(row.product_id))}}
  await withMocks({},require.resolve('../src/services/stockAlerts'),async c=>{
    await c.ensureStockAlertsBatch(db,[{id:'healthy',stock:'10',min_stock:'2'},{id:'zero',stock:'0.000000',min_stock:'0.1'}],'B')
    assert.deepEqual(healthy,['healthy'])
    assert.equal(created[0].type_id,'zero')
  })
})

test('adjustments aggregate measured duplicates and minimum accepts measured base stock',async()=>{
  const movements=[];let minimum
  const db={product:{findMany:async()=>[{id:'p',kind:'STANDARD',quantity_decimals:6}]},stockLocation:{findFirst:async()=>({id:'LOC'})},productStockLocation:{upsert:async({update})=>{minimum=update.min_stock;return update}},stockMovement:{createMany:async({data})=>movements.push(...data)},status:{findFirst:async()=>null},alertType:{findMany:async()=>[]},alertPriority:{findMany:async()=>[]},$executeRaw:async()=>1,$queryRaw:async(sql,...args)=>{const s=String(sql),v=args.flatMap(x=>x?.values||[]);if(s.includes('UPDATE product_stock_locations'))return[{product_id:'p',location_id:'LOC',qty:v[2],balance:v[2]}];if(s.includes('UPDATE product_stocks'))return[{id:'p',stock:v[1],min_stock:0}];throw Error(s)}}
  db.$transaction=async fn=>fn(branchRows(db))
  await withMocks({[model]:{prisma:db,prismaTransaction:db}},require.resolve('../src/modules/inventory/stock.controller'),async c=>{
    const req=body=>({companyId:'A',branchId:'B',user:{sub:'U'},body})
    let res=jsonResponse();await c.createAdjustment(req({location_id:'LOC',lines:[{product_id:'p',qty:'0.1'},{product_id:'p',qty:'0.2'}]}),res,e=>{throw e})
    assert.equal(res.statusCode,201)
    assert.equal(String(movements[0].qty),'0.3')
    await c.setLocationMin(req({location_id:'LOC',product_id:'p',min_stock:'0.25'}),jsonResponse(),e=>{throw e})
    assert.equal(String(minimum),'0.25')
  })
})

test('lot correction preserves consumed measured quantities and adjusts its original location',async()=>{
  let updated,delta
  const lot={id:'lot',product_id:'p',branch_id:'B',location_id:'LOC',qty_received:'0.3',qty_remaining:'0.2',product:{id:'p',kind:'STANDARD',quantity_decimals:6}}
  const db={productLot:{findUnique:async()=>lot,update:async({data})=>(updated=data)},product:{findMany:async()=>[lot.product]},$executeRaw:async()=>1,$queryRaw:async(sql,...args)=>{const s=String(sql),v=args.flatMap(x=>x?.values||[]);if(s.includes('UPDATE product_stock_locations')){delta=v[2];return[{product_id:'p',location_id:'LOC',qty:delta,balance:'0.4'}]};if(s.includes('UPDATE product_stocks'))return[{id:'p',stock:'0.4',min_stock:0}];throw Error(s)},stockMovement:{createMany:async()=>{}},status:{findFirst:async()=>null},alertType:{findMany:async()=>[]},alertPriority:{findMany:async()=>[]}}
  db.$transaction=async fn=>fn(branchRows(db))
  await withMocks({[model]:{prisma:db,prismaTransaction:db}},require.resolve('../src/modules/inventory/products.controller'),async c=>{
    await c.updateLot({companyId:'A',branchId:'B',params:{lotId:'lot'},user:{sub:'U'},body:{qty_received:'0.5'}},jsonResponse(),e=>{throw e})
    assert.equal(String(updated.qty_received),'0.5');assert.equal(String(updated.qty_remaining),'0.4');assert.equal(delta,'0.2')
  })
})

test('ordinary product edit keeps measured stock and branch minimum exact',async()=>{
  let branch={stock:'0.3',min_stock:'0.1'},movement
  let product={id:'p',kind:'STANDARD',company_id:'A',unit_metadata_version:2,base_unit_id:'u',unit_revision:1,quantity_decimals:6,stock:'0.3',min_stock:'0.1',price:'2',cost:'1',tracks_expiry:false}
  const unit={id:'u',code:'KG',name:'Kilogramo',label:'kg',factor:'1'}
  const db={systemSetting:{findUnique:async()=>({key:'inventory_units_enabled',value:'true'})},product:{findFirst:async()=>({...product}),findUnique:async()=>({...product}),findMany:async()=>[{...product}],update:async({data})=>{const stock=data.stock?.increment;product={...product,...data,...(stock!==undefined?{stock:new Prisma.Decimal(product.stock).add(stock).toFixed()}:{})};return {...product}}},productStock:{findMany:async()=>[{product_id:"p",...branch}],findUnique:async()=>({...branch}),update:async({data})=>(branch={...branch,...data})},measureUnit:{findFirst:async()=>unit,findMany:async()=>[unit]},productPresentation:{findMany:async()=>[]},productBarcode:{findMany:async()=>[]},stockMovement:{createMany:async({data})=>{movement=data[0]}},$executeRaw:async()=>1,$queryRaw:async(sql,...args)=>{if(String(sql).includes('SELECT l.id'))return[{id:'LOC'}];const v=args.flatMap(x=>x?.values||[]);return[{product_id:'p',location_id:'LOC',qty:v[2],balance:'0.5'}]},status:{findFirst:async()=>null},alertType:{findMany:async()=>[]},alertPriority:{findMany:async()=>[]}}
  db.$transaction=async fn=>fn(branchRows(db))
  await withMocks({[model]:{prisma:db,prismaTransaction:db}},require.resolve('../src/modules/inventory/products.controller'),async c=>{
    await c.update({companyId:'A',branchId:'B',params:{id:'p'},user:{sub:'U',permissions:['products.edit']},body:{stock:'0.5',min_stock:'0.25'}},jsonResponse(),e=>{throw e})
    assert.equal(String(branch.stock),'0.5');assert.equal(String(branch.min_stock),'0.25');assert.equal(product.stock,'0.5');assert.equal(String(movement.qty),'0.2')
  })
})

test('product stock overlay adds Prisma Decimals across locations without concatenating',async()=>{
  const db={product:{count:async()=>1,findMany:async()=>[{id:'p',kind:'STANDARD'}]},productStockLocation:{findMany:async()=>[{product_id:'p',stock:new Prisma.Decimal('0.1'),min_stock:new Prisma.Decimal('0.1')},{product_id:'p',stock:new Prisma.Decimal('0.2'),min_stock:new Prisma.Decimal('0.2')} ]}}
  await withMocks({[model]:{prisma:db,prismaTransaction:db}},require.resolve('../src/modules/inventory/products.controller'),async c=>{
    const res=jsonResponse();await c.list({companyId:'A',branchId:'B',query:{warehouse_id:'W'}},res,e=>{throw e})
    assert.equal(res.body.items[0].stock,'0.3');assert.equal(res.body.items[0].min_stock,'0.3')
  })
})

test('starting branch stock rejects a fractional minimum for indivisible products',async()=>{
  const product={id:'p',kind:'STANDARD',quantity_decimals:0}
  const db={product:{findFirst:async()=>product,findMany:async()=>[product]},productStock:{findUnique:async()=>null,create:async()=>({})},$executeRaw:async()=>1}
  db.$transaction=async fn=>fn(branchRows(db))
  await withMocks({[model]:{prisma:db,prismaTransaction:db}},require.resolve('../src/modules/inventory/products.controller'),async c=>{
    await assert.rejects(c.addToBranch({companyId:'A',branchId:'B',params:{id:'p'},body:{min_stock:'0.25'}},jsonResponse(),e=>{throw e}),/decimal/i)
  })
})

test('lot correction reloads the current quantity after acquiring the product lock',async()=>{
  let locked=false,delta
  const db={product:{findMany:async()=>[{id:'p',kind:'STANDARD',quantity_decimals:6}]},productLot:{findUnique:async()=>({id:'lot',product_id:'p',branch_id:'B',location_id:'LOC',qty_received:locked?'0.4':'0.3',qty_remaining:locked?'0.3':'0.2',product:{id:'p',kind:'STANDARD',quantity_decimals:6}}),update:async({data})=>data},stockMovement:{createMany:async()=>{}},$executeRaw:async sql=>{if(String(sql).includes('FROM products')&&String(sql).includes('FOR UPDATE'))locked=true;return 1},$queryRaw:async(sql,...args)=>{const s=String(sql),v=args.flatMap(x=>x?.values||[]);if(s.includes('UPDATE product_stock_locations')){delta=v[2];return[{product_id:'p',location_id:'LOC',qty:delta,balance:'0.4'}]};if(s.includes('UPDATE product_stocks'))return[{id:'p',stock:'0.4',min_stock:0}];throw Error(s)},status:{findFirst:async()=>null},alertType:{findMany:async()=>[]},alertPriority:{findMany:async()=>[]}}
  db.$transaction=async fn=>fn(branchRows(db))
  await withMocks({[model]:{prisma:db,prismaTransaction:db}},require.resolve('../src/modules/inventory/products.controller'),async c=>{
    await c.updateLot({companyId:'A',branchId:'B',params:{lotId:'lot'},user:{sub:'U'},body:{qty_received:'0.5'}},jsonResponse(),e=>{throw e})
    assert.equal(delta,'0.1')
  })
})

test('count accepts decimal strings, treats zero as counted and compares decimals by value',async()=>{
  let line={id:'l',product_id:'p',stock_snapshot:'0.3',qty_counted:null,qty_counted_secondary:null,product:{id:'p',kind:'STANDARD',quantity_decimals:6,cost:'2'}}
  const db={inventoryCountSession:{findFirst:async()=>({status:'IN_PROGRESS',scope_json:{doubleCount:true},branch_id:'B'})},inventoryCountLine:{findFirst:async()=>line,update:async({data})=>(line={...line,...data})}}
  db.$transaction=async fn=>fn(branchRows(db))
  await withMocks({[model]:{prisma:db,prismaTransaction:db}},require.resolve('../src/modules/inventory-count/controller'),async c=>{
    const request=body=>({params:{id:'s',lineId:'l'},user:{sub:'U'},companyId:'A',branchId:'B',body})
    let r=jsonResponse();await c.updateLine(request({qty_counted:'0.1',qty_counted_secondary:'0.100000'}),r,e=>{throw e})
    assert.equal(r.statusCode,200)
    assert.equal(String(line.qty_counted),'0.1')
    assert.equal(r.body.countMismatch,false)
    assert.equal(String(r.body.difference),'-0.2')
    r=jsonResponse();await c.updateLine(request({qty_counted:'0',qty_counted_secondary:'0'}),r,e=>{throw e})
    assert.equal(String(line.qty_counted),'0')
    assert.equal(String(r.body.difference),'-0.3')
  })
})

test('count line DTO computes a measured difference and its money value exactly',async()=>{
  const line={qty_counted:'0.1',stock_snapshot:'0.3',unit_snapshot:{version:2},product:{cost:'1.234567890123'}}
  const db={inventoryCountSession:{findFirst:async()=>({scope_json:{}})},inventoryCountLine:{findMany:async()=>[line],count:async()=>1}}
  await withMocks({[model]:{prisma:db,prismaTransaction:db}},require.resolve('../src/modules/inventory-count/controller'),async c=>{
    const res=jsonResponse();await c.listLines({params:{id:'s'},companyId:'A',query:{}},res,e=>{throw e})
    assert.equal(res.body.data[0].difference,'-0.2')
    assert.equal(res.body.data[0].valueDifference,'-0.25')
  })
})

test('internal movement keeps .3 base split and duplicate lines cannot bypass availability',async()=>{
  let stock='0.3';const movements=[]
  const db={product:{findMany:async({where})=>where.tracks_expiry?[]:[{id:'p',kind:'STANDARD',quantity_decimals:6}]},productStockLocation:{findMany:async()=>[{product_id:'p',stock,product:{name:'Medido'}}]},
    $executeRaw:async()=>1,$queryRaw:async(sql,...args)=>{
      if(String(sql).includes('SELECT l.id'))return[{id:'a'},{id:'b'}]
      const v=args.flatMap(x=>x?.values||[])
      return[{product_id:'p',location_id:'a',qty:v[2],balance:'0'},{product_id:'p',location_id:'b',qty:v[5],balance:'0.3'}]
    },stockMovement:{createMany:async({data})=>movements.push(...data)},productLot:{findMany:async()=>[]}}
  const {moveBetweenLocations}=require('../src/services/stockLocations')
  await moveBetweenLocations(db,{branchId:'B',fromLocationId:'a',toLocationId:'b',lines:[{product_id:'p',qty:'0.1'},{product_id:'p',qty:'0.2'}]})
  assert.deepEqual(movements.map(r=>String(r.qty)),['-0.3','0.3'])
  await assert.rejects(moveBetweenLocations(db,{branchId:'B',fromLocationId:'a',toLocationId:'b',lines:[{product_id:'p',qty:'0.2'},{product_id:'p',qty:'0.2'}]}),/solo hay|insuficiente/i)
})

test('two cancellations racing a measured transfer restore its frozen lots exactly once',async()=>{
  let status='EN_TRANSITO',stock=new Prisma.Decimal(0);const lots=[]
  const transfer={id:'t',from_branch_id:'B',to_branch_id:'C',lines:[{id:'l',product_id:'p',qty_sent:'0.3',lots_snapshot:[{qty:'0.1',lot_code:'old',unit_cost:'2'},{qty:'0.2',lot_code:'new',unit_cost:'3'}]}]}
  const db={stockTransfer:{findFirst:async()=>({...transfer,status}),updateMany:async({data})=>{if(status!=='EN_TRANSITO')return{count:0};status=data.status;return{count:1}},update:async({data})=>{status=data.status;return{...transfer,status}}},
    product:{findMany:async()=>[{id:'p',kind:'STANDARD',quantity_decimals:6}]},stockMovement:{findMany:async()=>[],createMany:async()=>{}},
    productLot:{create:async({data})=>lots.push(data)},status:{findFirst:async()=>null},alertType:{findMany:async()=>[]},alertPriority:{findMany:async()=>[]},
    $executeRaw:async()=>1,$queryRaw:async(sql,...args)=>{
      const s=String(sql),v=args.flatMap(x=>x?.values||[])
      if(s.includes('SELECT l.id'))return[{id:'LOC'}]
      if(s.includes('UPDATE product_stock_locations'))return[{product_id:'p',location_id:'LOC',qty:v[2],balance:v[2]}]
      if(s.includes('UPDATE product_stocks')){stock=stock.add(v[1]);return[{id:'p',stock:stock.toFixed(),min_stock:'0'}]}
      throw new Error('Unexpected SQL '+s)
    }}
  db.$transaction=async fn=>fn(branchRows(db))
  await withMocks({[model]:{prisma:db,prismaTransaction:db}},require.resolve('../src/modules/transfers/controller'),async c=>{
    const request={companyId:'A',branchId:'B',params:{id:'t'},user:{sub:'U'}}
    const results=await Promise.allSettled([c.cancel(request,jsonResponse(),e=>{throw e}),c.cancel(request,jsonResponse(),e=>{throw e})])
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1)
    assert.equal(stock.toFixed(),'0.3')
    assert.deepEqual(lots.map(r=>[String(r.qty_received),r.lot_code]),[['0.1','old'],['0.2','new']])
  })
})

test('measured transfer receipt splits its frozen lots and locks products before recreating them',async()=>{
  let locked=false,stock=new Prisma.Decimal(0);const lots=[]
  const transfer={id:'t',status:'EN_TRANSITO',to_branch_id:'B',lines:[{id:'l',product_id:'p',qty_sent:'0.3',unit_snapshot:{version:2,baseUnit:{id:'u',code:'KG',decimals:6},factor:'1'},lots_snapshot:[{qty:'0.1',lot_code:'A',unit_cost:'2'},{qty:'0.2',lot_code:'B',unit_cost:'3'}]}]}
  const db={stockTransfer:{findFirst:async()=>transfer,findUnique:async()=>transfer,updateMany:async()=>({count:1})},stockTransferLine:{update:async()=>{}},product:{findMany:async()=>[{id:'p',kind:'STANDARD',quantity_decimals:6}]},productLot:{create:async({data})=>{assert(locked,'Product lock must precede lot creation');lots.push(data)}},stockMovement:{createMany:async()=>{}},status:{findFirst:async()=>null},alertType:{findMany:async()=>[]},alertPriority:{findMany:async()=>[]},$executeRaw:async sql=>{if(String(sql).includes('FROM products')&&String(sql).includes('FOR UPDATE'))locked=true;return 1},$queryRaw:async(sql,...args)=>{const s=String(sql),v=args.flatMap(x=>x?.values||[]);if(s.includes('SELECT l.id'))return[{id:'LOC'}];if(s.includes('UPDATE product_stock_locations'))return[{product_id:'p',location_id:'LOC',qty:v[2],balance:v[2]}];if(s.includes('UPDATE product_stocks')){stock=stock.add(v[1]);return[{id:'p',stock:stock.toFixed(),min_stock:0}]};throw Error(s)}}
  db.$transaction=async fn=>fn(branchRows(db))
  await withMocks({[model]:{prisma:db,prismaTransaction:db}},require.resolve('../src/modules/transfers/controller'),async c=>{
    await c.receive({companyId:'A',branchId:'B',params:{id:'t'},user:{sub:'U'},body:{lines:[{line_id:'l',qty_received:'0.2'}]}},jsonResponse(),e=>{throw e})
    assert.equal(stock.toFixed(),'0.2')
    assert.deepEqual(lots.map(l=>[String(l.qty_received),l.lot_code,String(l.unit_cost)]),[['0.1','A','2'],['0.1','B','3']])
  })
})
