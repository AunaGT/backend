const {test}=require('node:test'),assert=require('node:assert/strict')
const {readBarcodeLayout,saveBarcodeLayout}=require('../src/modules/inventory/barcodeLabels/layouts')
const {createLabelTemplate,defaultPaper}=require('../src/modules/inventory/barcodeLabels/validation')
test('default layout reads without writes, then saves by revision without overwriting another editor',async()=>{
  let row=null,writes=0
  const db={companyModule:{findMany:async()=>[{module_code:'inventory',status:'ACTIVE'}]},systemSetting:{findUnique:async()=>row,upsert:async({create,update})=>{writes++;row={...(row||create),...update};return row}},$executeRaw:async()=>0}
  db.$transaction=fn=>fn(db)
  const scope={companyId:'11111111-1111-4111-8111-111111111111',userId:'user',isAdmin:true,permissions:[]}
  const initial=await readBarcodeLayout(db,scope);assert.equal(initial.revision,0);assert.equal(writes,0)
  const raw={expectedRevision:0,design:createLabelTemplate('price'),defaultPaper:defaultPaper()}
  const saved=await saveBarcodeLayout(db,scope,raw);assert.equal(saved.revision,1)
  await assert.rejects(()=>saveBarcodeLayout(db,scope,raw),e=>e.status===409);assert.equal(writes,1)
  assert.equal((await readBarcodeLayout(db,scope)).design.elements.some(e=>e.field==='price'),true)
  await assert.rejects(()=>saveBarcodeLayout(db,{...scope,isAdmin:false,permissions:['products.view']},{...raw,expectedRevision:1}),e=>e.status===403)
})
