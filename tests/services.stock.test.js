const test=require('node:test')
const assert=require('node:assert/strict')
const {withMocks,jsonResponse}=require('./helpers/reportHarness.cjs')
const model=require.resolve('../src/models/prisma')
const bom=require.resolve('../src/services/bomStock')
test('commercial stock map is tenant scoped, validates quantities and skips only real services',async()=>{
  let lookup
  const rows=[{id:'s',name:'Asesoría',kind:'SERVICE',quantity_decimals:2,service_unit_label:'Hora'},{id:'b',kind:'STANDARD'}]
  const tx={product:{findMany:async args=>{lookup=args;return rows.filter(row=>args.where.id.in.includes(row.id))}}}
  await withMocks({[model]:{prisma:tx}},bom,async service=>{
    assert.deepEqual(await service.expandLinesToStockMap(tx,[{product_id:'s',qty:'1.5'},{product_id:'b',qty:2}],{companyId:'A'}),new Map([['b',2]]))
    assert.equal(lookup.where.company_id,'A')
    await assert.rejects(service.expandLinesToStockMap(tx,[{product_id:'missing',qty:'1'}],{companyId:'A'}),/encontrado/i)
    await assert.rejects(service.expandLinesToStockMap(tx,[{product_id:'b',qty:'1.5'}],{companyId:'A'}),/decimal/i)
    await assert.rejects(service.expandLinesToStockMap(tx,[{product_id:'s',qty:'1.001'}],{companyId:'A'}),/decimal/i)
    rows[0].quantity_decimals=0
    assert.deepEqual(await service.expandLinesToStockMap(tx,[{product_id:'s',qty:'1.5',item_kind:'SERVICE',quantity_decimals:2}],{companyId:'A'}),new Map())
  })
})
test('services have commercial availability without a stock query or location',async()=>{
  const tx={systemSetting:{findUnique:async()=>({value:'true'})},product:{findMany:async()=>[{id:'s',kind:'SERVICE',available_for_sale:true,quantity_decimals:2,service_unit_label:'Hora'}]}}
  const physical=require.resolve('../src/services/stockAvailability')
  await withMocks({[model]:{prisma:tx},[physical]:{getAvailabilityBatch:async()=>assert.fail('No service stock query')}},bom,async service=>{
    assert.deepEqual(await service.getAvailabilityBatchWithKits(['s'],tx,null,{companyId:'A'}),{s:{tracks_stock:false,available_for_sale:true,unit_label:'Hora',quantity_decimals:2}})
  })
})
test('shared physical writes reject service IDs before creating any stock or location row',async()=>{
  let productLocks=0
  const tx={product:{findMany:async()=>[{id:'s',kind:'SERVICE'}]},$executeRaw:async sql=>{assert.match(String(sql),/^SELECT id FROM products .*ORDER BY id FOR UPDATE$/);productLocks++;return 1},$queryRaw:async()=>assert.fail('No stock locks')}
  const stock=require.resolve('../src/services/stockAvailability')
  const locations=require.resolve('../src/services/stockLocations')
  await withMocks({[model]:{prisma:tx}},stock,async service=>{
    await assert.rejects(service.ensureBranchStockRows(tx,['s'],'B'),/servicio/i)
  })
  await withMocks({[model]:{prisma:tx}},locations,async service=>{
    await assert.rejects(service.applyLocationDeltas(tx,[{product_id:'s',location_id:'L',qty:1}],{branchId:'B'}),/servicio/i)
    await assert.rejects(service.applyBranchDelta(tx,[['s',1]],'B',1),/servicio/i)
  })
  assert.equal(productLocks,3)
})
test('direct product physical routes reject services before any write',async()=>{
  const tx={product:{findFirst:async()=>({id:'s',kind:'SERVICE'}),update:async()=>assert.fail('Must reject before converting to KIT')},$transaction:async run=>run(tx)}
  const target=require.resolve('../src/modules/inventory/products.controller')
  await withMocks({[model]:{prisma:tx,prismaTransaction:tx}},target,async controller=>{
    for(const name of ['getBom','updateBom','addToBranch','removeFromBranch','getLots']){
      await assert.rejects(controller[name]({companyId:'A',branchId:'B',params:{id:'s'},body:{components:[]}}, jsonResponse(),error=>{throw error}),/servicio/i,name)
    }
  })
})
