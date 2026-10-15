const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto')
const {withBarcodeDevFixture,devDbEnabled}=require('./helpers/barcodeDevFixture.cjs'),{prepareBarcodeLabels}=require('../src/modules/inventory/barcodeLabels/preparations'),{readBarcodeLayout,saveBarcodeLayout,listBarcodeCandidates}=require('../src/modules/inventory/barcodeLabels/layouts')
test('authorized dev flow: manual kit, CAS, forbidden products, fresh-client replay',{skip:!devDbEnabled},()=>withBarcodeDevFixture(async({db,scope,fixtures:f})=>{
  const initial=await readBarcodeLayout(db,scope);assert.equal(initial.revision,0)
  const writes={expectedRevision:0,design:initial.design,defaultPaper:initial.defaultPaper}
  const saves=await Promise.allSettled([saveBarcodeLayout(db,scope,writes),saveBarcodeLayout(db,scope,writes)]);assert.equal(saves.filter(r=>r.status==='fulfilled').length,1);assert.equal(saves.find(r=>r.status==='rejected').reason.code,'LAYOUT_CONFLICT')
  assert.equal((await readBarcodeLayout(db,scope)).revision,1)
  const input=f.prepareInput({mode:'manual',value:'012345000058'});input.items[0].productId=f.secondGoodsId;input.design.barcodeType='upca';input.design.heightMm=60
  const result=await prepareBarcodeLabels(db,scope,input);assert.equal(result.products[0].barcode,'012345000058');assert.equal(Object.hasOwn(result.products[0],'cost'),false)
  const fresh=new db.constructor();try{assert.deepEqual(await prepareBarcodeLabels(fresh,scope,input),result)}finally{await fresh.$disconnect()}
  await assert.rejects(()=>prepareBarcodeLabels(db,{...scope,companyId:crypto.randomUUID()},input),e=>e.code==='FORBIDDEN')
  await db.product.update({where:{id:f.goodsId},data:{available_for_sale:false}})
  const candidates=await listBarcodeCandidates(db,scope,{pageSize:100});assert.deepEqual(candidates.items.map(p=>p.id),[f.secondGoodsId])
  await assert.rejects(()=>prepareBarcodeLabels(db,scope,f.prepareInput()),e=>e.code==='PRODUCT_UNAVAILABLE')
  await db.product.update({where:{id:f.goodsId},data:{available_for_sale:true,deleted:true}})
  await assert.rejects(()=>prepareBarcodeLabels(db,scope,f.prepareInput()),e=>e.code==='PRODUCT_UNAVAILABLE')
  await assert.rejects(()=>saveBarcodeLayout(db,{...scope,isAdmin:false,permissions:['products.view','products.export']},{...writes,expectedRevision:1}),e=>e.code==='FORBIDDEN')
}))
