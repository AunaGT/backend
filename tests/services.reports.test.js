const test=require('node:test'),assert=require('node:assert/strict')
const {buildInventoryReport,buildProductsReport}=require('../src/modules/reports/models/catalog')
const {buildFinancialReport}=require('../src/modules/reports/models/commercial')
const meta={}
const {withMocks}=require('./helpers/reportHarness.cjs')
test('report data scopes physical queries and groups net service revenue by original unit',async()=>{
  const db={saleStatus:{findFirst:async()=>({id:1})},sale:{findMany:async()=>[{id:'v',branch_id:'B',date:new Date(),total:250,total_returned:50,adjusted_total:200}]},saleItem:{findMany:async()=>[{product_id:'b',qty:'2',price:50,net_total:100,unit_cost:30,item_kind:'STANDARD',unit_label:'unidad',sale:{id:'v'},product:{name:'Bien',category:{name:'Bienes'},cost:99}},{product_id:'s',qty:'1.5',price:100,net_total:150,item_kind:'SERVICE',item_name:'Asesoría original',unit_label:'Hora',quantity_decimals:2,sale:{id:'v'},product:{name:'Nombre editado',cost:999,category:{name:'Servicios'}},return_items:[{qty_returned:'0.5',refund_amount:50,restock_qty:null}]}]},product:{findMany:async({where})=>{assert.deepEqual(where.kind,{not:'SERVICE'});return[]}}}
  await withMocks({[require.resolve('../src/models/prisma')]:{prisma:db},[require.resolve('../src/services/inTransit')]:{inTransitTotals:async()=>({units:0,value:0})}},require.resolve('../src/modules/reports/controller'),async controller=>{
    const result=await controller.getFinancialData(null,null,{companyId:'A',branchId:'B',reportPeriod:{start:null,endExclusive:null},query:{}})
    assert.equal(result.totalGoodsRevenue,100);assert.equal(result.totalServiceRevenue,100);assert.equal(result.totalCost,60)
    assert.equal(result.unidadesTotales,2)
    assert.equal(result.quantitiesByUnit.find(row=>row.unit==='Hora').quantity,'1.5')
    assert.equal(result.topProducts.find(row=>row.unit==='Hora').name,'Asesoría original')
  })
})
test('physical inventory excludes services and service catalog contains no inventory valuation',()=>{
  const rows=[{name:'Bien',kind:'STANDARD',stock:2,cost:30},{name:'Asesoría',kind:'SERVICE',stock:99,cost:999,service_unit_label:'Hora',quantity_decimals:3,price:100,available_for_sale:true}]
  const inventory=buildInventoryReport({products:rows},meta)
  assert.equal(inventory.sections[0].rows.length,1)
  const services=buildProductsReport({catalogType:'services',products:rows.filter(p=>p.kind==='SERVICE'),summary:{}},meta)
  assert.equal(services.sections[0].rows[0].unit,'Hora')
  for(const field of ['stock','cost','value','margin']) assert.equal(services.sections[0].columns.some(c=>c.id===field),false)
})
test('financial reports distinguish service revenue without presenting uncosted service net profit',()=>{
  const report=buildFinancialReport({totalRevenueGross:250,totalReturned:0,totalRevenue:250,totalCost:30,totalProfit:220,totalGoodsRevenue:100,totalServiceRevenue:150,serviceLines:1,grossMarginPct:88,inventoryValueOwned:0,categoryProfitability:[],byBranch:[],byWarehouse:[],purchasesAttributable:false},meta)
  assert.ok(report.sections[0].rows.some(row=>row.concept==='Ingresos netos de servicios' && row.amount===150))
  assert.match(report.notes.join(' '),/servicio.*costeo|costeo.*servicio/i)
})
