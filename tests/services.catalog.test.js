const test = require('node:test')
const assert = require('node:assert/strict')
const { withMocks, jsonResponse } = require('./helpers/reportHarness.cjs')
const model = require.resolve('../src/models/prisma')
const target = require.resolve('../src/modules/inventory/products.controller')
const enabled = { systemSetting: { findUnique: async () => ({ value: 'true' }) } }
test('restoring an archived service is a new catalog operation and remains blocked with the preference off',async()=>{
  const db={systemSetting:{findUnique:async()=>({value:'false'})},product:{findFirst:async()=>({id:'s',kind:'SERVICE'}),update:async()=>assert.fail('Must not reactivate service')}}
  await withMocks({[model]:{prisma:db}},target,async controller=>{
    await assert.rejects(controller.restore({companyId:'A',params:{id:'s'}},jsonResponse(),error=>{throw error}),error=>error.status===403)
  })
})

test('service filtering is applied before pagination and never overlays physical stock', async () => {
  let selection
  const counts = []
  const prisma = { ...enabled, product: { count: async ({ where }) => { counts.push(where); return counts.length === 1 ? 11 : 3 },
    findMany: async args => { selection = args; return [{ id:'s',name:'Asesoría',kind:'SERVICE',stock:0,service_unit_label:'Hora',quantity_decimals:2 }] } },
    productStock: { findMany: async () => { assert.fail('Services must not query branch stock') } } }
  await withMocks({ [model]: { prisma, prismaTransaction: prisma } }, target, async controller => {
    const res = jsonResponse()
    await controller.list({companyId:'A',branchId:'B',query:{catalog_type:'services',includeSummary:'true',pageSize:'12'}},res,error=>{throw error})
    assert.equal(selection.where.kind, 'SERVICE')
    assert.equal(selection.where.company_id, 'A')
    assert.equal(selection.take, 12)
    assert.equal(res.body.totalItems, 11)
    assert.deepEqual(res.body.summary, { total:11,forSale:3,notForSale:3,fractional:3 })
    assert.equal(res.body.items[0].kind,'SERVICE')
  })
})

test('service creation requires no supplier, writes no stock and rejects forged physical fields', async () => {
  const created = []
  const prisma = { ...enabled, productCategory: { findFirst: async () => ({id:1,company_id:'A'}) }, stockStatus: { findFirst:async()=>({id:1}) },
    product: { create:async({data})=>{created.push(data);return{id:'s',...data}} },
    productStock:{findMany:async()=>{assert.fail('No physical row for a service')}},
    $transaction:async run=>run(prisma) }
  const payload = { name:'Asesoría',kind:'SERVICE',category_id:1,service_unit_label:'Hora',quantity_decimals:2,price:'100',available_for_sale:true }
  await withMocks({[model]:{prisma,prismaTransaction:prisma}},target,async controller=>{
    const res = jsonResponse()
    await controller.create({companyId:'A',branchId:'B',body:payload},res,error=>{throw error})
    assert.equal(res.statusCode,201)
    assert.equal(created[0].kind,'SERVICE')
    assert.equal(created[0].supplier_id,null)
    assert.equal(created[0].stock,0)
    assert.equal(created[0].cost,0)
    await assert.rejects(controller.create({companyId:'A',branchId:'B',body:{...payload,stock:1}},jsonResponse(),error=>{throw error}),/servicio/i)
    assert.equal(created.length,1)
  })
})

test('disabled services cannot be created and physical type cannot be converted to service', async () => {
  const prisma = { systemSetting:{findUnique:async()=>({value:'false'})},product:{findFirst:async()=>({id:'b',kind:'STANDARD',deleted:false})} }
  await withMocks({[model]:{prisma,prismaTransaction:prisma}},target,async controller=>{
    await assert.rejects(controller.create({companyId:'A',branchId:'B',body:{kind:'SERVICE',service_unit_label:'Hora',quantity_decimals:2}},jsonResponse(),error=>{throw error}),error=>error.status===403)
    await assert.rejects(controller.update({companyId:'A',branchId:'B',params:{id:'b'},body:{kind:'SERVICE'}},jsonResponse(),error=>{throw error}),/tipo|convertir/i)
  })
})
test('service prices and metadata are bounded and goods still require a scoped supplier',async()=>{
  const prisma={...enabled,stockStatus:{findFirst:async()=>({id:1})},productCategory:{findFirst:async()=>({id:1})},product:{create:async()=>assert.fail('Invalid input must not write')},$transaction:async run=>run(prisma)}
  const service={name:'Asesoría',kind:'SERVICE',category_id:1,service_unit_label:'Hora',quantity_decimals:2,price:'100'}
  await withMocks({[model]:{prisma,prismaTransaction:prisma}},target,async controller=>{
    for(const invalid of [{price:'10000000000'},{price:'1.001'},{name:'x'.repeat(151)},{bom_components:[]}]){
      await assert.rejects(controller.create({companyId:'A',branchId:'B',body:{...service,...invalid}},jsonResponse(),error=>{throw error}),error=>error.status===400)
    }
    const res=jsonResponse()
    await controller.create({companyId:'A',branchId:'B',body:{name:'Bien',kind:'STANDARD',category_id:1,price:100}},res,error=>{throw error})
    assert.equal(res.statusCode,400)
    assert.match(res.body.message,/proveedor/i)
  })
})
test('service export shares commercial fields and leaves physical fields blank',async()=>{
  let report
  const branding=require.resolve('../src/utils/pdfBranding')
  const reports=require.resolve('../src/modules/reports/controller')
  const prisma={...enabled,product:{findMany:async()=>[{id:'s',name:'Asesoría',kind:'SERVICE',service_unit_label:'Hora',quantity_decimals:2,price:100,stock:0,cost:0,available_for_sale:true}]}}
  await withMocks({[model]:{prisma},[branding]:{getBrandingForPdf:async()=>({company_name:'QA',currency_code:'GTQ'})},[reports]:{sendCsv:(res,name,meta,sections)=>{report={meta,sections}}}},target,async controller=>{
    await controller.reportPdf({companyId:'A',query:{catalog_type:'services',format:'csv',fields:'name,kind,service_unit_label,quantity_decimals,stock,cost'}},jsonResponse(),error=>{throw error})
    assert.deepEqual(report.sections[0].rows[0],['Asesoría','Servicio','Hora','2','',''])
    assert.equal(report.meta.some(value=>value.startsWith('Unidades,')),false)
  })
})
test('editing goods cannot assign a supplier or category from another tenant',async()=>{
  const prisma={product:{findFirst:async()=>({id:'b',kind:'STANDARD'})},supplier:{findFirst:async()=>null},productCategory:{findFirst:async()=>null},$transaction:async()=>assert.fail('No cross-tenant writes')}
  await withMocks({[model]:{prisma,prismaTransaction:prisma}},target,async controller=>{
    for(const body of [{supplier_id:'00000000-0000-4000-8000-000000000001'},{category_id:2}]){
      const res=jsonResponse()
      await controller.update({companyId:'A',branchId:'B',params:{id:'b'},body},res,error=>{throw error})
      assert.equal(res.statusCode,400)
    }
  })
})
test('commercial history is scoped, paginated and remains readable with services disabled',async()=>{
  let lookup
  const prisma={product:{findFirst:async()=>({id:'s',kind:'SERVICE'})},saleItem:{count:async()=>1,findMany:async args=>{lookup=args;return[{qty:'1.5',item_kind:'SERVICE',unit_label:'Hora',quantity_decimals:2,sale:{id:'v',reference:'V-1'}}]}}}
  await withMocks({[model]:{prisma}},target,async controller=>{
    const res=jsonResponse()
    await controller.commercialHistory({companyId:'A',branchId:'B',params:{id:'s'},query:{page:'1'}},res,error=>{throw error})
    assert.deepEqual(lookup.where.sale.AND[0],{status:{name:'Completada'}})
    assert.equal(lookup.where.sale.AND[1].branch.company_id,'A')
    assert.equal(lookup.where.sale.AND[1].branch_id,'B')
    assert.equal(lookup.take,10)
    assert.equal(res.body.items[0].unit_label,'Hora')
    assert.equal(res.body.totalItems,1)
  })
})
test('commercial history accepts bounded page sizes and applies the same size to offsets and totals', async () => {
  let lookup
  const prisma = { product: { findFirst: async () => ({ id: 's' }) }, saleItem: { count: async () => 250, findMany: async args => { lookup = args; return [] } } }
  await withMocks({ [model]: { prisma } }, target, async controller => {
    for (const [input, expected] of [['25', 25], ['100', 100], ['999', 100], ['-1', 10], ['2.5', 10], ['bad', 10]]) {
      const res = jsonResponse()
      await controller.commercialHistory({ companyId: 'A', branchId: 'B', params: { id: 's' }, query: { page: '2', pageSize: input } }, res, error => { throw error })
      assert.equal(lookup.take, expected); assert.equal(lookup.skip, expected)
      assert.equal(res.body.pageSize, expected); assert.equal(res.body.totalPages, Math.ceil(250 / expected))
      assert.equal(lookup.where.sale.AND[1].branch.company_id, 'A')
    }
  })
})
