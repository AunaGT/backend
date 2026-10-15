const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto')
const {withBarcodeDevFixture,devDbEnabled}=require('./helpers/barcodeDevFixture.cjs'),{prepareBarcodeLabels}=require('../src/modules/inventory/barcodeLabels/preparations')
test('real database race, replay, scope, rollback and no stock effects',{skip:!devDbEnabled},()=>withBarcodeDevFixture(async({db,scope,fixtures:f})=>{
  const input=f.prepareInput(),[a,b]=await Promise.all([prepareBarcodeLabels(db,scope,input),prepareBarcodeLabels(db,scope,input)])
  assert.deepEqual(a,b);assert.equal(await db.barcodePrintPreparation.count({where:{company_id:scope.companyId}}),1)
  assert.equal((await db.product.findUnique({where:{id:f.goodsId}})).barcode,a.products[0].barcode)
  await assert.rejects(()=>prepareBarcodeLabels(db,scope,{...input,requestKey:crypto.randomUUID()}),e=>e.code==='STALE_BARCODE')
  await assert.rejects(()=>prepareBarcodeLabels(db,scope,{...input,items:[{...input.items[0],copies:3}]}),e=>e.code==='REQUEST_CONFLICT')
  const existing={...input,requestKey:crypto.randomUUID(),confirmAssignments:false,items:[{...input.items[0],expectedBarcode:a.products[0].barcode,assignment:{mode:'keep'}}]}
  const viewer={...scope,isAdmin:false,permissions:['products.view','products.export']}
  assert.equal((await prepareBarcodeLabels(db,viewer,existing)).products[0].barcode,a.products[0].barcode)
  const bad=f.prepareInput();bad.items=[{...bad.items[0],productId:f.secondGoodsId},{...bad.items[0],productId:f.serviceId}]
  await assert.rejects(()=>prepareBarcodeLabels(db,scope,bad),e=>e.code==='PRODUCT_UNAVAILABLE')
  assert.equal((await db.product.findUnique({where:{id:f.secondGoodsId}})).barcode,null)
  const forced=f.prepareInput();forced.items=[{...forced.items[0],productId:f.secondGoodsId}]
  await assert.rejects(()=>prepareBarcodeLabels(db,{...scope,userId:crypto.randomUUID()},forced),e=>e.code==='P2003')
  assert.equal((await db.product.findUnique({where:{id:f.secondGoodsId}})).barcode,null,'record insertion failure rolls back assigned code')
  assert.equal(await db.stockMovement.count({where:{product_id:{in:[f.goodsId,f.secondGoodsId]}}}),0)
  assert.equal((await db.product.findUnique({where:{id:f.goodsId}})).price.toString(),'25')
  await db.product.update({where:{id:f.goodsId},data:{barcode:'AUNA999999999999'}})
  await assert.rejects(()=>prepareBarcodeLabels(db,scope,input),e=>e.code==='STALE_BARCODE')
}))
