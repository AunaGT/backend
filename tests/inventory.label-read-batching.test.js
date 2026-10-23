const test=require('node:test'),assert=require('node:assert/strict')
const {listBarcodeCandidates}=require('../src/modules/inventory/barcodeLabels/layouts'),{labelFixture,preparationFixture,id}=require('./helpers/labelReadFixture.cjs')
const {prepareBarcodeLabels}=require('../src/modules/inventory/barcodeLabels/preparations'),{prepareShelfLabels}=require('../src/modules/inventory/barcodeLabels/shelfPrices')
for(const purpose of ['barcode','shelf'])for(const count of [1,10,100])test(`${purpose} candidates return every option with constant grouped reads for${count} products`,async()=>{
 const f=labelFixture(count,3),result=await listBarcodeCandidates(f.db,f.scope,{pageSize:'100'},purpose)
 assert.equal(result.items.length,count);assert.equal(result.items.reduce((n,p)=>n+p.unitOptions.length,0),count*4)
 assert.equal(result.items[0].unitOptions[1].price,'31.5');assert.equal(result.items[0].unitOptions[1].barcode,'0000')
 if(purpose==='shelf')assert.deepEqual(result.items[0].unitOptions[1].shelfPrices.map(p=>p.amount),['31.5','24','18'])
 assert.equal(f.calls.length,8,JSON.stringify(f.calls.map(c=>c.name)));assert.ok(!f.calls.some(c=>['product.findFirst','base.findFirst','presentation.findFirst'].includes(c.name)))
 const productRead=f.calls.find(c=>c.name==='product.findMany');assert.equal(productRead.args.take,100);assert.equal(productRead.args.select.cost,undefined)
 for(const row of result.items){assert.equal(row.cost,undefined);assert.equal(row.company_id,undefined);assert.equal(row.base_unit_id,undefined);assert.equal(row.unitOptions[1].company_id,undefined)}
})
test('label page scope and totals remain intact and only its page IDs enter unit reads',async()=>{
 const f=labelFixture(2,2)
 for(const extra of [{company_id:id(80001)},{deleted:true},{available_for_sale:false},{kind:'SERVICE'}])f.products.push({...f.products[0],id:id(80000+f.products.length),...extra})
 const result=await listBarcodeCandidates(f.db,f.scope,{page:'2',pageSize:'1',search:'Producto',in_branch:'true'})
 assert.equal(result.totalItems,2);assert.equal(result.items[0].id,id(2));assert.equal(result.items[0].unitOptions.length,3)
 const pres=f.calls.find(c=>c.name==='presentation.findMany');assert.deepEqual(pres.args.where.product_id.in,[id(2)]);assert.equal(pres.args.where.company_id,f.scope.companyId)
 const query=f.calls.find(c=>c.name==='product.findMany');assert.deepEqual(query.args.where.branch_stocks,{some:{branch_id:f.scope.branchId}});assert.equal(result.items[0].price,'5.25')
})
test('disabled units and empty pages perform no unit reads or expose internal metadata',async()=>{
 const f=labelFixture(1,2);f.settings[0].value='false'
 let result=await listBarcodeCandidates(f.db,f.scope,{});assert.equal(result.items[0].unitOptions,undefined);assert.equal(result.items[0].base_unit_id,undefined);assert.equal(f.calls.length,5)
 f.calls.length=0;f.settings[0].value='true';result=await listBarcodeCandidates(f.db,f.scope,{page:'99',pageSize:'1'});assert.deepEqual(result.items,[]);assert.equal(result.totalItems,1);assert.equal(f.calls.length,5)
})
for(const purpose of ['barcode','shelf'])for(const count of [1,10])test(`${purpose} preparation batches base and presentation reads for${count} products inside the existing locks`,async()=>{
 const f=preparationFixture(count,3),input=f.input(purpose),prepare=purpose==='shelf'?prepareShelfLabels:prepareBarcodeLabels,result=await prepare(f.db,f.scope,input)
 assert.equal(result.products.length,count*4);assert.equal(result.products[1].unit_snapshot.factor,'6');assert.equal(result.products[1].price,'31.5');assert.equal(result.products[1].barcode,'0000');assert.equal(result.products[1].unit_revision,1);assert.equal(f.snapshots.length,1);assert.deepEqual(f.writes,['snapshot'])
 if(purpose==='shelf')assert.deepEqual(result.products[1].shelfPrices.map(p=>p.amount),['31.5','24','18'])
 for(const name of ['base.findMany','presentation.findMany','code.findMany'])assert.equal(f.calls.filter(c=>c.name===name).length,1,name)
 assert.equal(f.calls.filter(c=>c.name==='product.findFirst').length,purpose==='shelf'?count:0)
 assert.equal(f.calls.filter(c=>c.name==='setting.findUnique').length,2)
 const firstContext=f.calls.findIndex(c=>c.name==='base.findMany'),locks=f.calls.map((c,i)=>c.name.startsWith('lock.')?i:-1).filter(i=>i>=0);assert.ok(locks.length);assert.ok(locks.every(i=>i<firstContext))
 const before=f.calls.length;f.products[0].price='99';f.presentations[0].factor='12';assert.deepEqual(await prepare(f.db,f.scope,input),result);assert.equal(f.snapshots.length,1);assert.ok(!f.calls.slice(before).some(c=>['base.findMany','presentation.findMany','code.findMany'].includes(c.name)))
})
for(const purpose of ['barcode','shelf'])test(`${purpose} failed revision or scope leaves no partial snapshot or assignment`,async()=>{
 for(const mode of ['revision','base','presentation','scope',...(purpose==='barcode'?['code']:[])]){
  const f=preparationFixture(),input=f.input(purpose),prepare=purpose==='shelf'?prepareShelfLabels:prepareBarcodeLabels
  if(mode==='revision')f.products[0].unit_revision=2
  if(mode==='base')f.bases.length=0
  if(mode==='presentation')f.presentations[0].sale_enabled=false
  if(mode==='scope')f.products[0].company_id=id(900099)
  if(mode==='code')input.items[0].expectedBarcode='STALE'
  await assert.rejects(prepare(f.db,f.scope,input),error=>[404,409].includes(error.status));assert.equal(f.snapshots.length,0);assert.equal(f.writes.length,0)
 }
})
test('grouped preparation preserves reserved-code checks, permissions and fresh context on automatic retry',async()=>{
 let f=preparationFixture(),input=f.input('barcode');input.items=[{...input.items[1],expectedBarcode:null,assignment:{mode:'manual',value:'RESERVED'}}];f.codes.length=0;f.codes.push({id:id(80001),company_id:f.scope.companyId,product_id:id(80002),presentation_id:null,code:'RESERVED',active:false});input.confirmAssignments=true
 await assert.rejects(prepareBarcodeLabels(f.db,f.scope,input),e=>e.code==='BARCODE_CONFLICT');assert.equal(f.writes.length,0)
 await assert.rejects(prepareBarcodeLabels(f.db,{...f.scope,permissions:['products.view','products.export']},input),e=>e.status===403)
 f=preparationFixture();f.products[0].barcode=null;input=f.input('barcode');input.items=[{...input.items[0],expectedBarcode:null,assignment:{mode:'auto'}}];input.confirmAssignments=true
 f.codes.push({id:id(80001),company_id:f.scope.companyId,product_id:id(80002),presentation_id:null,code:'AUNA000000000000',active:false})
 const crypto=require('node:crypto'),original=crypto.randomBytes;let attempts=0;crypto.randomBytes=()=>Buffer.alloc(6,attempts++?1:0)
 try{const result=await prepareBarcodeLabels(f.db,f.scope,input);assert.equal(result.products[0].barcode,'AUNA010101010101');assert.equal(attempts,2);assert.equal(f.snapshots.length,1);assert.equal(f.calls.filter(c=>c.name==='base.findMany').length,2)}finally{crypto.randomBytes=original}
})
