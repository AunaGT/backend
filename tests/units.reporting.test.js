const test=require('node:test'),assert=require('node:assert/strict')
const {withMocks,jsonResponse}=require('./helpers/reportHarness.cjs')
const model=require.resolve('../src/models/prisma')
test('warehouse deactivation checks nonzero product rows without cancelling different stock dimensions',async()=>{
 let written=false;const prisma={stockLocation:{findFirst:async()=>({id:'L',warehouse_id:'W'}),update:async()=>{written=true}},productStockLocation:{aggregate:async()=>({_sum:{stock:0}}),count:async q=>{assert.deepEqual(q.where,{location_id:'L',stock:{not:0}});return 2}},$transaction:async fn=>fn(prisma)}
 await withMocks({[model]:{prisma}},require.resolve('../src/modules/inventory/warehouses.controller'),async c=>{const res=jsonResponse();await c.updateLocation({companyId:'A',branchId:'B',params:{locationId:'L'},body:{active:false}},res,e=>{throw e});assert.equal(res.statusCode,400);assert.equal(written,false)})
})
test('product CSV exports scoped exact stock with its base label and counts products without summing dimensions',async()=>{
 const prisma={systemSetting:{findUnique:async()=>({key:'inventory_units_enabled',value:'true'})},product:{findMany:async q=>q.select?[{id:'P',base_unit_id:'kg',base_unit:{id:'kg',label:'kg'},quantity_decimals:6}]:[{id:'P',name:'Peso',stock:'0.123456',min_stock:'0.000001',cost:'0.123456789012',price:'1',kind:'STANDARD'}]},productStock:{findMany:async()=>[{product_id:'P',stock:'0.123456',min_stock:'0.000001'}]},branch:{findUnique:async()=>({name:'Central'})}}
 await withMocks({[model]:{prisma},[require.resolve('../src/utils/pdfBranding')]:{getBrandingForPdf:async()=>({company_name:'QA',currency_code:'GTQ'})}},require.resolve('../src/modules/inventory/products.controller'),async c=>{const res={setHeader(){},send(v){this.body=v}};await c.reportPdf({companyId:'A',branchId:'B',query:{format:'csv',fields:'name,stock,min_stock,cost'}},res,e=>{throw e});assert.match(res.body,/0\.123456 kg/);assert.match(res.body,/0\.000001 kg/);assert.match(res.body,/0\.123456789012/);assert.doesNotMatch(res.body,/Unidades,0\.123456/)})
})
test('advanced warehouse listing counts product-location rows rather than mixing physical dimensions',async()=>{
 const prisma={systemSetting:{findUnique:async()=>({key:'inventory_units_enabled',value:'true'})},warehouse:{findMany:async()=>[{id:'W',locations:[{id:'L'}]}]},branch:{findUnique:async()=>({})},productStockLocation:{groupBy:async q=>{assert.deepEqual(q._count,{product_id:true});assert.equal(q.where.product.company_id,'A');return[{location_id:'L',_count:{product_id:2}}]}}}
 await withMocks({[model]:{prisma}},require.resolve('../src/modules/inventory/warehouses.controller'),async c=>{const res=jsonResponse();await c.list({companyId:'A',branchId:'B',query:{},user:{}},res,e=>{throw e});assert.equal(res.body[0].stock_lines,2);assert.equal(res.body[0].stock_units,null)})
})
test('sales reporting groups physical base quantities and frozen unit IDs instead of commercial captions',async()=>{
 const sale={id:'S',branch_id:'B',date:new Date('2026-10-01T12:00:00Z'),total:'20',total_returned:0},items=[{product_id:'P',qty:'1',base_qty:'25',unit_label:'saco',unit_metadata_version:2,base_unit_cost:'0.2',unit_snapshot:{version:2,baseUnit:{id:'kg',label:'kg'}}},{product_id:'P',qty:'1',base_qty:'0.123456',unit_label:'caja',unit_metadata_version:2,base_unit_cost:'0.2',unit_snapshot:{version:2,baseUnit:{id:'kg',label:'kg'}}}].map(i=>({...i,price:'10',net_total:'10',product:{name:'Peso',kind:'STANDARD'},sale,return_items:[]}))
 const prisma={branch:{findMany:async()=>[{id:'B',name:'Central'}]},saleStatus:{findFirst:async()=>({id:1})},saleItem:{findMany:async()=>items},sale:{findMany:async()=>[sale]}}
 await withMocks({[model]:{prisma},[require.resolve('../src/utils/pdfBranding')]:{getBrandingForPdf:async()=>({timezone:'America/Guatemala'})}},require.resolve('../src/modules/reports/controller'),async c=>{const res=jsonResponse();await c.salesReport({companyId:'A',branchId:'B',query:{format:'json',period:'all'}},res,e=>{throw e});const rows=res.body.sections.find(s=>s.id==='quantities').rows;assert.deepEqual(rows,[{type:'Bien',unit:'kg',quantity:'25.123456'}]);assert.equal(res.body.sections.find(s=>s.id==='top-products').rows[0].ventas,'25.123456')})
})
test('identical captions from distinct base unit IDs do not create a dimensional sum',()=>{
 const {buildInventoryReport}=require('../src/modules/reports/models/catalog'),r=buildInventoryReport({products:[{name:'A',stock:'1',cost:'1',base_unit_id:'mass',base_unit:{label:'medida'}},{name:'B',stock:'2',cost:'1',base_unit_id:'volume',base_unit:{label:'medida'}}]},{});assert.equal(r.summary.find(m=>m.id==='units').value,null)
})
test('accounting returns restore the frozen physical allocation value rather than an average kit cost',()=>{
 const {buildReturnPosting}=require('../src/services/accounting/postingEngine'),defaults=Object.fromEntries(['salesReturns','sales','cash','bank','receivables','inventory','cogs','pequenoTax','pequenoTaxExpense'].map(id=>[id,{id}]))
 const lines=buildReturnPosting({total_refund:'10',sale:{payment_method:{name:'Efectivo'}},return_items:[{unit_metadata_version:2,base_qty:'1',base_restock_qty:'1',physical_snapshot:{version:1,entries:[{base_qty:'0.25',base_unit_cost:'12'}]},sale_item:{item_kind:'KIT',base_unit_cost:'2.142857142857'}}]},{defaults,splitVat:false,ivaRate:0,costBase:c=>c,pequenoTaxOf:()=>0})
 assert.equal(lines.find(l=>l.account_id==='inventory').debit,3)
})
test('v2 merchandise report uses frozen commercial line totals instead of multiplying rounded costs',async()=>{
 const prisma={systemSetting:{findUnique:async()=>({key:'inventory_units_enabled',value:'true'})},branch:{findMany:async()=>[{id:'B',name:'Central'}]},incomingMerchandise:{findMany:async query=>{assert.equal(query.include.items.select.line_total,true);return[{date:new Date('2026-10-02'),payment_status:'PENDING',items:[{quantity:'3',unit_cost:'0.333333',unit_metadata_version:2,line_total:'1.01',base_qty:'21',base_unit_cost:'0.048095238095'}]}]}}}
 await withMocks({[model]:{prisma},[require.resolve('../src/utils/pdfBranding')]:{getBrandingForPdf:async()=>({company_name:'QA',currency_code:'GTQ',timezone:'America/Guatemala'})}},require.resolve('../src/modules/reports/controller'),async c=>{const res=jsonResponse();await c.merchandiseReport({companyId:'A',branchId:'B',query:{format:'json',period:'all'}},res,e=>{throw e});assert.equal(res.body.summary.find(m=>m.id==='received').value,1.01)})
})
test('count CSV retains exact six-place difference and frozen base label',async()=>{
 const prisma={inventoryCountSession:{findFirst:async()=>({id:'C',name:'Conteo',status:'DRAFT'})},inventoryCountLine:{findMany:async()=>[{stock_snapshot:'0.2',qty_counted:'0.3',qty_counted_secondary:null,unit_snapshot:{version:2,baseUnit:{label:'kg'}},product:{name:'Peso',cost:'1'},location:{code:'A',warehouse:{name:'Principal'}}}]}}
 await withMocks({[model]:{prisma},[require.resolve('../src/utils/pdfBranding')]:{getBrandingForPdf:async()=>({company_name:'QA',currency_code:'GTQ'})}},require.resolve('../src/modules/reports/controller'),async c=>{const res={setHeader(){},send(v){this.body=v}};await c.inventoryCountSessionReport({companyId:'A',branchId:'B',params:{id:'C'},query:{format:'csv'}},res,e=>{throw e});assert.match(res.body,/Peso · kg/);assert.match(res.body,/,0\.1,/);assert.doesNotMatch(res.body,/0\.099999/)})
})
test('measured report rows retain exact base quantity/unit and mixed dimensions are never a units total',()=>{
 const {buildKardexReport,buildInternalMovesReport}=require('../src/modules/reports/models/stock'),meta={}
 const movements=[{id:'a',product_id:'p',created_at:new Date(),qty:'0.123456',balance:'1.123456',unit_snapshot:{version:2,baseUnit:{id:'kg',label:'kg',decimals:6}},product:{id:'p',name:'Peso'}},{id:'b',product_id:'q',created_at:new Date(),qty:'2.5',balance:'4',unit_snapshot:{version:2,baseUnit:{id:'L',label:'L',decimals:6}},product:{id:'q',name:'Volumen'}}]
 const report=buildKardexReport({movements},meta);assert.equal(report.sections[0].rows[0].incoming,'0.123456');assert.equal(report.sections[0].rows[0].unit,'kg');assert.equal(report.sections[0].columns.find(c=>c.id==='incoming').quantityDecimals,6);assert.equal(report.summary.find(m=>m.id==='in').value,null)
 const internal=buildInternalMovesReport({movements},meta);assert.equal(internal.sections[0].rows[0].units,'0.123456');assert.equal(internal.summary.find(m=>m.id==='units').value,null)
})
test('inventory prepared report includes base unit and exact six-place stock with no mixed-unit sum',()=>{
 const {buildInventoryReport}=require('../src/modules/reports/models/catalog'),report=buildInventoryReport({products:[{name:'Peso',stock:'0.123456',cost:'2',base_unit_id:'kg',base_unit:{label:'kg'}},{name:'Volumen',stock:'1',cost:'3',base_unit_id:'L',base_unit:{label:'L'}}]},{});assert.equal(report.sections[0].rows[0].stock,'0.123456');assert.equal(report.sections[0].rows[0].unit,'kg');assert.equal(report.summary.find(m=>m.id==='units').value,null)
})
test('replenishment read retains company-scoped physical unit and six-place base values',async()=>{
  const queries=[]
  const prisma={systemSetting:{findUnique:async()=>({key:'inventory_units_enabled',value:'true'})},product:{findMany:async query=>{queries.push(query);return[{id:'p',quantity_decimals:6,base_unit:{label:'kg',code:'KG'}}]}}}
  await withMocks({[model]:{prisma},[require.resolve('../src/services/stockLocations')]:{replenishmentSuggestions:async()=>[{product_id:'p',stock:'0.123456',missing:'0.876544'}]}},require.resolve('../src/modules/inventory/stock.controller.js'),async controller=>{
    const res=jsonResponse();await controller.replenishment({companyId:'A',branchId:'B'},res,error=>{throw error})
    assert.equal(res.body[0].stock,'0.123456');assert.equal(res.body[0].base_unit.label,'kg');assert.equal(res.body[0].quantity_decimals,6)
    assert.deepEqual(queries[0].where,{company_id:'A',id:{in:['p']}})
  })
})
test('flag-off replenishment never selects new Prisma unit relations',async()=>{
  const prisma={systemSetting:{findUnique:async()=>({key:'inventory_units_enabled',value:'false'})},product:{findMany:async()=>assert.fail('old client relation selected')}}
  await withMocks({[model]:{prisma},[require.resolve('../src/services/stockLocations')]:{replenishmentSuggestions:async()=>[{product_id:'p',stock:1}]}},require.resolve('../src/modules/inventory/stock.controller.js'),async controller=>{const res=jsonResponse();await controller.replenishment({companyId:'A',branchId:'B'},res,error=>{throw error});assert.deepEqual(res.body,[{product_id:'p',stock:1}])})
})
test('expiry read derives unlotted decimal base exactly and selects unit metadata only when enabled',async()=>{
  let enabled=true;const queries=[]
  const prisma={systemSetting:{findUnique:async()=>({key:'inventory_units_enabled',value:String(enabled)}),findMany:async()=>[]},productLot:{findMany:async q=>{queries.push(q);return[{id:'lot',product_id:'p',qty_remaining:'0.1',expiry_date:new Date('2026-10-18'),product:{id:'p',stock:'9',branch_stocks:[{stock:'0.3'}],base_unit:{label:'kg',code:'KG'}}}]},groupBy:async()=>[{product_id:'p',_sum:{qty_remaining:'0.1'}}]}}
  await withMocks({[model]:{prisma}},require.resolve('../src/modules/inventory/products.controller'),async c=>{
    const req={companyId:'A',branchId:'B',query:{}},res=jsonResponse();await c.lotsExpiring(req,res,e=>{throw e})
    assert.equal(res.body.lots[0].product.unlotted,'0.2');assert.equal(res.body.lots[0].product.stock,'0.3');assert.ok(queries[0].include.product.select.base_unit)
    enabled=false;await c.lotsExpiring(req,jsonResponse(),e=>{throw e});assert.equal(queries[1].include.product.select.base_unit,undefined)
  })
})
test('kit BOM read labels each measured component from its scoped base without changing its fraction',async()=>{
  const prisma={systemSetting:{findUnique:async()=>({key:'inventory_units_enabled',value:'true'})},product:{findFirst:async()=>({id:'kit',kind:'KIT'}),findMany:async({where})=>{assert.equal(where.company_id,'A');return[{id:'p',base_unit_id:'kg',quantity_decimals:6,base_unit:{label:'kg',code:'KG'}}]}},productBomLine:{findMany:async()=>[{component_product_id:'p',qty_per_unit:'0.25',component_product:{id:'p',name:'Componente'}}]}}
  await withMocks({[model]:{prisma}},require.resolve('../src/modules/inventory/products.controller'),async c=>{const res=jsonResponse();await c.getBom({params:{id:'kit'},companyId:'A'},res,e=>{throw e});assert.equal(res.body.components[0].qty_per_unit,'0.25');assert.equal(res.body.components[0].component_product.base_unit.label,'kg')})
})
