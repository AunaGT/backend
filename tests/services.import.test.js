const test = require('node:test')
const assert = require('node:assert/strict')
const { withMocks } = require('./helpers/reportHarness.cjs')
const model = require.resolve('../src/models/prisma')
const target = require.resolve('../src/services/bulkImport')

test('service import preserves type and rejects physical fields without requiring a supplier', async () => {
  const prisma={systemSetting:{findUnique:async()=>({value:'true'})},productCategory:{findMany:async()=>[{id:1,name:'Servicios'}]},supplier:{findMany:async()=>[]},product:{findMany:async()=>[]}}
  await withMocks({[model]:{prisma}},target,async service=>{
    const rows=[{nombre:'Asesoría',categoria:'Servicios',precio:'100',tipo:'SERVICE',unidad_cobro:'Hora',decimales:2},
      {nombre:'Inválido',categoria:'Servicios',precio:'100',tipo:'SERVICE',unidad_cobro:'Hora',decimales:2,stock:1}]
    const result=await service.validateBulkData(rows,{}, {companyId:'A'})
    assert.equal(result.totals.valid,1)
    assert.equal(result.totals.invalid,1)
    assert.equal(result.validRows[0].data.kind,'SERVICE')
    assert.equal(result.validRows[0].data.supplier_id,null)
    assert.match(result.invalidRows[0].errors.join(' '),/servicio.*stock/i)
  })
})

test('service bulk creation creates neither a supplier nor branch stock and rechecks activation', async () => {
  const created=[]
  const prisma={systemSetting:{findUnique:async()=>({value:'true'})},product:{create:async({data})=>{created.push(data);return{id:'s',...data}}},productStock:{create:async()=>assert.fail('No service stock')}}
  await withMocks({[model]:{prisma}},target,async service=>{
    const rows=[{rowIndex:2,data:{name:'Asesoría',kind:'SERVICE',category_id:1,service_unit_label:'Hora',quantity_decimals:2,price:100}}]
    const result=await service.bulkCreateProducts(rows,{companyId:'A',branchId:'B'})
    assert.equal(result.created,1)
    assert.equal(created[0].supplier_id,null)
    prisma.systemSetting.findUnique=async()=>({value:'false'})
    const denied=await service.bulkCreateProducts(rows,{companyId:'A',branchId:'B'})
    assert.equal(denied.created,0)
    assert.equal(created.length,1)
  })
})
