const test = require('node:test')
const assert = require('node:assert/strict')
process.env.JWT_SECRET ||= 'merchandise-test-only-secret-at-least-32-characters'
test('own production detail retains its costs without assuming a supplier or payable',async()=>{
  const {withMocks,jsonResponse}=require('./helpers/reportHarness.cjs')
  const record={id:'own',source:'PRODUCTION',supplier:null,production_details:{total:'16.00'},registeredBy:{id:'U',name:'Persona'},items:[{id:'line',product:{id:'P',name:'Producto'},quantity:'3',unit_cost:'5.333333333333',line_total:'16.00'}]}
  await withMocks({[require.resolve('../src/models/prisma')]:{prisma:{incomingMerchandise:{findFirst:async()=>record}}}},require.resolve('../src/modules/merchandise/controller'),async controller=>{
    const response=jsonResponse();await controller.getById({params:{id:'own'},companyId:'A',branchId:'B',user:{sub:'U'}},response,e=>{throw e})
    assert.equal(response.body.supplier.name,'Fabricación propia');assert.equal(response.body.production_details.total,'16.00');assert.equal(String(response.body.items[0].subtotal),'16.00')
  })
})
test('exported production and opening records never claim a pending supplier payment',async()=>{
  const {withMocks}=require('./helpers/reportHarness.cjs')
  for(const source of ['PRODUCTION','INITIAL']){
    const text=[],record={source,date:new Date(),supplier:null,registeredBy:{name:'Persona'},payment_status:'PENDING',items:[{product:{name:'Producto'},quantity:3,unit_cost:'5.333333333333',line_total:'16.00'}]}
    const doc=new Proxy({page:{width:600,height:800,margins:{left:50,right:50,top:50,bottom:50}},y:50},{get(target,key){if(key in target)return target[key];if(key==='text')return value=>{text.push(String(value));return doc};if(key==='heightOfString')return()=>10;return()=>doc}})
    await withMocks({[require.resolve('../src/models/prisma')]:{prisma:{incomingMerchandise:{findMany:async()=>[record]}}},[require.resolve('pdfkit')]:function(){return doc},[require.resolve('../src/utils/pdfBranding')]:{getBrandingForPdf:async()=>({}),PDF_COLORS:{},setupReportPdf(){},ensureReportSpace(){},drawReportTable(){},finishReportPdf(){}}},require.resolve('../src/modules/merchandise/controller'),async controller=>{
      await controller.generateReport({companyId:'A',branchId:'B',query:{}},{setHeader(){}},e=>{throw e})
      assert.match(text.join('\n'),/Sin cuentas por pagar/);assert.doesNotMatch(text.join('\n'),/Pendiente de pago|Término de pago|Vencimiento:/);assert.match(text.join('\n'),/Total del registro: Q16.00/)
    })
  }
})

test('detalle de mercancía entrega imágenes reales sin alterar costos ni saldo', async () => {
  const dbPath = require.resolve('../src/models/prisma')
  const controllerPath = require.resolve('../src/modules/merchandise/controller')
  const previous = require.cache[dbPath]
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { prisma: {
    incomingMerchandise: { findFirst: async ({ where, include }) => {
      assert.equal(where.branch.company_id, 'company-a')
      assert.equal(include.items.include.product.select.image_url, true)
      return { id: 'receipt', supplier: { id: 'supplier', name: 'Proveedor' }, registeredBy: { id: 'user', name: 'Usuario' }, date: new Date(), payment_status: 'PARTIAL', paymentEntries: [{ id: 'payment', amount: 5, paid_at: new Date() }], items: [{ id: 'line', product: { id: 'product', name: 'Producto', image_url: '/product.png' }, quantity: 3, unit_cost: 10 }] }
    } }
  } } }
  try {
    delete require.cache[controllerPath]
    let data
    await require(controllerPath).getById({ params: { id: 'receipt' }, companyId: 'company-a', branchId:'branch-a', branchIds:['branch-a'],user:{sub:'user'} }, { json: value => { data = value } }, error => { throw error })
    assert.equal(data.items[0].product.image_url, '/product.png')
    assert.equal(data.totalValue, 30)
    assert.equal(data.amount_pending, 25)
  } finally {
    delete require.cache[controllerPath]
    if (previous) require.cache[dbPath] = previous
    else delete require.cache[dbPath]
  }
})

test('el reporte conserva la búsqueda y el aislamiento de la sucursal del listado', async () => {
  const dbPath = require.resolve('../src/models/prisma')
  const controllerPath = require.resolve('../src/modules/merchandise/controller')
  const previous = require.cache[dbPath]
  let query
  const stop = new Error('stop before PDF rendering')
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { prisma: { incomingMerchandise: { findMany: async args => { query = args; throw stop } } } } }
  try {
    delete require.cache[controllerPath]
    await require(controllerPath).generateReport({ companyId: 'company-a', branchId: 'branch-a', query: { search: 'Proveedor', payment_status: 'PARTIAL' } }, {}, error => { assert.equal(error, stop) })
    assert.equal(query.where.branch_id, 'branch-a')
    assert.equal(query.where.payment_status, 'PARTIAL')
    assert.equal(query.where.OR[0].supplier.name.contains, 'Proveedor')
  } finally {
    delete require.cache[controllerPath]
    if (previous) require.cache[dbPath] = previous
    else delete require.cache[dbPath]
  }
})
