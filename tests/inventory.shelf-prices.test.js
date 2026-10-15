const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto')
const validation=require('../src/modules/inventory/barcodeLabels/validation')
test('shelf price selection keeps tariff identities and omits expired or absent prices without substituting list',()=>{
  const {shelfPricesForProduct}=require('../src/modules/inventory/barcodeLabels/shelfPrices'),now=new Date('2026-10-14T12:00:00Z')
  const product={price:'10.00',price_wholesale:null,price_promotion:'7.50',promotion_valid_until:new Date('2026-10-15T12:00:00Z')}
  assert.deepEqual(shelfPricesForProduct(product,['LIST','WHOLESALE','PROMOTION'],'PROMOTION',now).prices,[{tier:'PROMOTION',label:'Promoción',amount:'7.50'},{tier:'LIST',label:'Normal',amount:'10.00'}])
  product.promotion_valid_until=new Date('2026-10-13T12:00:00Z')
  const result=shelfPricesForProduct(product,['PROMOTION'],'PROMOTION',now);assert.equal(result.prices.length,0);assert.equal(result.warnings.length,1)
})
test('shelf prepare payload cannot assign codes, inject price amounts, or enter barcode prepare endpoint',()=>{
  const raw={requestKey:crypto.randomUUID(),scope:{branchId:crypto.randomUUID(),inBranch:false},items:[{productId:crypto.randomUUID(),copies:1,expectedBarcode:null,assignment:{mode:'keep'},priceTiers:['LIST']}],design:validation.createShelfLabelTemplate(),paper:validation.defaultPaper(),confirmAssignments:false}
  assert.equal(validation.parseShelfPreparationInput(raw).items[0].expectedBarcode,null)
  assert.throws(()=>validation.parsePreparationInput(raw))
  raw.items[0].assignment.mode='auto';assert.throws(()=>validation.parseShelfPreparationInput(raw));raw.items[0].assignment.mode='keep'
  raw.items[0].price='0.01';assert.throws(()=>validation.parseShelfPreparationInput(raw))
})
test('shelf preparation reads authoritative prices without editing product, preserves exact replay and rejects stale prices',async()=>{
  const {prepareShelfLabels}=require('../src/modules/inventory/barcodeLabels/shelfPrices'),companyId=crypto.randomUUID(),branchId=crypto.randomUUID(),productId=crypto.randomUUID(),userId=crypto.randomUUID(),rows=[],product={id:productId,name:'Café',kind:'STANDARD',price:'10.00',price_wholesale:'8.00',price_promotion:'7.00',promotion_valid_until:null,barcode:null,brand:null,size:null}
  const db={companyModule:{findMany:async()=>[{module_code:'inventory',status:'ACTIVE'}]},branch:{findFirst:async({where})=>where.id===branchId&&where.company_id===companyId?{id:branchId}:null},company:{findUnique:async()=>({name:'QA'})},product:{findMany:async({where})=>{assert.equal(where.company_id,companyId);assert.equal(where.available_for_sale,true);assert.deepEqual(where.kind,{not:'SERVICE'});return[product]},update:()=>{throw Error('Must not mutate product')}},systemSetting:{findMany:async()=>[]},barcodePrintPreparation:{findUnique:async()=>rows[0],create:async({data})=>{rows.push(data);return data}},$executeRaw:async()=>0};db.$transaction=fn=>fn(db)
  const input={requestKey:crypto.randomUUID(),scope:{branchId,inBranch:false},items:[{productId,copies:3,expectedBarcode:null,assignment:{mode:'keep'},priceTiers:['LIST','PROMOTION']}],design:validation.createShelfLabelTemplate('price'),paper:validation.defaultPaper(),confirmAssignments:false},scope={companyId,branchId,branchIds:[branchId],userId,isAdmin:false,permissions:['products.view','products.export']}
  input.design.primaryTier='PROMOTION'
  const result=await prepareShelfLabels(db,scope,input);assert.equal(result.products[0].shelfPrices[0].amount,'7.00');assert.equal(result.products[0].shelfPrices.length,2);assert.equal(result.products[0].barcode,'');assert.equal(result.assignedProductIds.length,0);assert.equal(Object.hasOwn(result.products[0],'cost'),false)
  assert.deepEqual(await prepareShelfLabels(db,scope,input),result);assert.equal(rows.length,1)
  // PostgreSQL JSONB does not retain object key order.
  rows[0].snapshot=JSON.parse(JSON.stringify(result));rows[0].snapshot.products[0]=Object.fromEntries(Object.entries(result.products[0]).reverse())
  assert.deepEqual(await prepareShelfLabels(db,scope,input),rows[0].snapshot)
  product.price_promotion='6.00';await assert.rejects(()=>prepareShelfLabels(db,scope,input),e=>e.code==='STALE_PRICES')
  product.price_wholesale=null;await assert.rejects(()=>prepareShelfLabels(db,scope,{...input,requestKey:crypto.randomUUID(),items:[{...input.items[0],priceTiers:['WHOLESALE']}]}),e=>e.code==='PRICE_UNAVAILABLE')
})
test('saved shelf design is isolated from barcode design and concurrent revision cannot overwrite it',async()=>{
  const {readBarcodeLayout,saveBarcodeLayout}=require('../src/modules/inventory/barcodeLabels/layouts'),rows=new Map(),db={companyModule:{findMany:async()=>[{module_code:'inventory',status:'ACTIVE'}]},systemSetting:{findUnique:async({where})=>rows.get(where.company_id_key.key)||null,upsert:async({where,create,update})=>{const row={...(rows.get(where.company_id_key.key)||create),...update};rows.set(where.company_id_key.key,row);return row}},$executeRaw:async()=>0};db.$transaction=fn=>fn(db)
  const scope={companyId:crypto.randomUUID(),isAdmin:true,permissions:[]},shelf=await readBarcodeLayout(db,scope,'shelf');assert.equal(shelf.design.purpose,'shelf');assert.equal(shelf.capabilities.canAssign,false)
  const input={expectedRevision:0,design:shelf.design,defaultPaper:shelf.defaultPaper};await saveBarcodeLayout(db,scope,input,'shelf');assert.equal((await readBarcodeLayout(db,scope)).revision,0);assert.equal((await readBarcodeLayout(db,scope,'shelf')).revision,1)
  await assert.rejects(()=>saveBarcodeLayout(db,scope,input,'shelf'),e=>e.code==='LAYOUT_CONFLICT');await assert.rejects(()=>saveBarcodeLayout(db,scope,input),e=>e.status===400)
})
