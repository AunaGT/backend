const test=require('node:test'),assert=require('node:assert/strict')
const units=require('../src/modules/inventory/units')
const scope={companyId:'A',branchId:'B',permissions:['products.edit','products.view']}
test('code normalization preserves leading zeroes and rejects non-string and blank codes',()=>{
  assert.equal(units.normalizeCode('  00123  '),'00123')
  for(const value of [123,'  ','a'.repeat(101)])assert.throws(()=>units.normalizeCode(value),e=>e.status===400)
})
test('a base code cannot collide with a presentation or an archived reservation',async()=>{
  const db={productBarcode:{findFirst:async({where})=>where.company_id==='A'&&where.code==='00123'?{product_id:'P',presentation_id:'box',active:false}:null},product:{findFirst:async()=>null}}
  await assert.rejects(units.assertCodeAvailable(db,scope,' 00123 ',{productId:'P',presentationId:null}),e=>e.status===409)
  assert.equal(await units.assertCodeAvailable(db,{...scope,companyId:'X'},'00123',{productId:'P'}),'00123')
})
test('legacy product codes reserve the same company namespace as new presentation codes',async()=>{
  const db={productBarcode:{findFirst:async()=>null},product:{findFirst:async()=>({id:'legacy'})}}
  await assert.rejects(units.assertCodeAvailable(db,scope,' 00123 ',{productId:'P',presentationId:'box'}),e=>e.status===409)
})
test('concurrent code reservations have exactly one winner and report a conflict',async()=>{
  const rows=[]
  const db={product:{findFirst:async()=>null},productBarcode:{findFirst:async()=>null,create:async({data})=>{await Promise.resolve();if(rows.some(r=>r.company_id===data.company_id&&r.code===data.code))throw Object.assign(Error('unique'),{code:'P2002'});rows.push(data);return data}}}
  const results=await Promise.allSettled([units.reserveCode(db,scope,' 00123 ',{productId:'P',presentationId:'box'}),units.reserveCode(db,scope,'00123',{productId:'Q'})])
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1)
  assert.equal(results.find(r=>r.status==='rejected').reason.status,409);assert.equal(rows.length,1)
})
test('barcode lookup returns presentation identity and current revision only inside company scope',async()=>{
  const db={systemSetting:{findUnique:async()=>({key:'inventory_units_enabled',value:'true'})},productBarcode:{findFirst:async({where})=>where.company_id==='A'?{product_id:'P',presentation_id:'box',active:true}:null},product:{findFirst:async({where})=>where.id==='P'?{id:'P',company_id:'A',unit_revision:4,base_unit_id:'u',deleted:false}:null},productPresentation:{findFirst:async()=>({id:'box',active:true,sale_enabled:true})}}
  assert.deepEqual(await units.resolveBarcode(db,scope,'00123'),{product_id:'P',presentation_id:'box',unit_revision:4})
  await assert.rejects(units.resolveBarcode(db,{...scope,companyId:'X'},'00123'),e=>e.status===404)
})
test('barcode label assignment cannot bypass presentation code reservations',async()=>{
  const crypto=require('node:crypto'),{prepareBarcodeLabels}=require('../src/modules/inventory/barcodeLabels/preparations')
  const {createLabelTemplate,defaultPaper}=require('../src/modules/inventory/barcodeLabels/validation')
  const companyId=crypto.randomUUID(),branchId=crypto.randomUUID(),productId=crypto.randomUUID()
  const product={id:productId,name:'Bien',kind:'STANDARD',barcode:null,price:'2',brand:null,size:null}
  const db={companyModule:{findMany:async()=>[{module_code:'inventory',status:'ACTIVE'}]},branch:{findFirst:async()=>({id:branchId})},
    systemSetting:{findUnique:async()=>({key:'inventory_units_enabled',value:'true'})},$executeRaw:async()=>0,$queryRaw:async()=>[],
    product:{findMany:async()=>[product],findFirst:async({where})=>where.id===productId?product:null,update:async()=>assert.fail('Cannot assign a presentation code to the base product')},
    productBarcode:{findFirst:async()=>({product_id:'other',presentation_id:'box',code:'00123',active:true})},barcodePrintPreparation:{findUnique:async()=>null}}
  db.$transaction=async run=>run(db)
  const input={requestKey:crypto.randomUUID(),scope:{branchId,inBranch:false},items:[{productId,copies:1,expectedBarcode:null,assignment:{mode:'manual',value:'00123'}}],design:createLabelTemplate(),paper:defaultPaper(),confirmAssignments:true}
  await assert.rejects(prepareBarcodeLabels(db,{companyId,branchId,branchIds:[branchId],userId:crypto.randomUUID(),isAdmin:true,permissions:[]},input),e=>e.status===409&&e.code==='BARCODE_CONFLICT')
  assert.equal(product.barcode,null)
})
