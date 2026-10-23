const test=require('node:test'),assert=require('node:assert/strict')
const api=require('../src/modules/inventory/barcodeLabels/unitSelection'),{labelFixture,id}=require('./helpers/labelReadFixture.cjs')
const now=new Date('2030-01-01T12:00:00Z')
async function load(f,enabled=true){assert.equal(typeof api.loadLabelUnitContext,'function');return api.loadLabelUnitContext(f.db,f.scope,f.products,enabled,now)}
const resolve=(f,context,item={},p=f.products[0],enabled=true)=>api.resolveLabelSelection(f.db,f.scope,p,{unit_revision:1,...item},enabled,context)
test('grouped unit context resolves exact base and presentation prices without per-selection reads',async()=>{
 const f=labelFixture(2,3),ctx=await load(f),reads=f.calls.length
 const base=await resolve(f,ctx),pack=await resolve(f,ctx,{presentation_id:f.presentations[0].id})
 assert.equal(base.price,'5.25');assert.equal(base.unit_label,'kg');assert.equal(pack.price,'31.5');assert.equal(pack.price_wholesale,'24');assert.equal(pack.price_promotion,'18');assert.equal(pack.barcode,'0000');assert.equal(pack.unit_snapshot.factor,'6');assert.equal(pack.selectionId,f.products[0].id+':'+f.presentations[0].id)
 assert.equal(reads,3);assert.equal(f.calls.length,reads);assert.ok(f.calls.every(c=>c.args.where.company_id===f.scope.companyId))
})
test('context uses one price instant and preserves overrides, expired promotions and exact factors',async()=>{
 const f=labelFixture();f.presentations[0].factor='0.125';f.presentations[0].price='25';f.presentations[0].price_promotion='2';f.presentations[0].promotion_valid_until=new Date('2029-12-31');f.products[0].promotion_valid_until=new Date('2030-01-02')
 let result=await resolve(f,await load(f),{presentation_id:f.presentations[0].id});assert.equal(result.price,'25');assert.equal(result.price_wholesale,'0.5');assert.equal(result.price_promotion,'0.375');assert.equal(result.unit_snapshot.factor,'0.125')
 f.presentations[0].price=null;f.products[0].promotion_valid_until=new Date('2029-12-31');result=await resolve(f,await load(f),{presentation_id:f.presentations[0].id});assert.equal(result.price,'0.65625');assert.equal(result.price_promotion,null)
})
test('grouped context rejects missing bases, stale revisions and ambiguous active codes',async()=>{
 let f=labelFixture();f.bases.length=0;await assert.rejects(resolve(f,await load(f)),e=>e.code==='UNIT_METADATA_REVIEW_REQUIRED')
 f=labelFixture();await assert.rejects(resolve(f,await load(f),{unit_revision:2}),e=>e.code==='UNIT_REVISION_CONFLICT')
 f.codes.push({...f.codes[0],id:id(80000),code:'999'});await assert.rejects(resolve(f,await load(f),{presentation_id:f.presentations[0].id}),e=>e.code==='BARCODE_REVIEW_REQUIRED')
})
test('context never resolves another product presentation or a foreign company context',async()=>{
 const f=labelFixture(2),ctx=await load(f)
 await assert.rejects(resolve(f,ctx,{presentation_id:f.presentations[1].id}),e=>e.code==='PRESENTATION_UNAVAILABLE')
 await assert.rejects(api.resolveLabelSelection(f.db,{...f.scope,companyId:id(900099)},f.products[0],{unit_revision:1},true,ctx),e=>e.status===403)
 await assert.rejects(resolve(f,ctx,{}, {...f.products[0],id:id(80001)}),e=>e.code==='PRODUCT_UNAVAILABLE')
})
test('inactive, purchase-only and foreign presentations and codes cannot enter sale labels',async()=>{
 const f=labelFixture(1,3);f.presentations[0].active=false;f.presentations[1].sale_enabled=false;f.presentations[2].company_id=id(900099)
 const ctx=await load(f)
 for(const p of f.presentations)await assert.rejects(resolve(f,ctx,{presentation_id:p.id}),e=>e.code==='PRESENTATION_UNAVAILABLE')
 f.codes.push({...f.codes[0],company_id:id(900099),code:'OTHER'});assert.equal((await resolve(f,await load(f))).barcode,'0010')
})
test('legacy and disabled unit contexts need no unit reads and retain their review rules',async()=>{
 const f=labelFixture();f.products[0].unit_metadata_version=1
 let ctx=await load(f);assert.equal(f.calls.length,0);const legacy=await resolve(f,ctx);assert.equal(legacy.selectionId,f.products[0].id);assert.equal(legacy.unit_snapshot,undefined)
 await assert.rejects(resolve(f,ctx,{presentation_id:f.presentations[0].id}),e=>e.code==='UNIT_METADATA_REVIEW_REQUIRED')
 ctx=await load(f,false);assert.equal(f.calls.length,0);await assert.rejects(resolve(f,ctx,{},f.products[0],false),e=>e.code==='UNITS_DISABLED')
 const p=await api.resolveLabelSelection(f.db,f.scope,f.products[0],{},false,ctx);assert.equal(p.selectionId,f.products[0].id)
})
test('a new context observes changed definitions without mutating the previous invocation',async()=>{
 const f=labelFixture(),old=await load(f);f.presentations[0].factor='12';const next=await load(f)
 assert.equal((await resolve(f,old,{presentation_id:f.presentations[0].id})).price,'31.5');assert.equal((await resolve(f,next,{presentation_id:f.presentations[0].id})).price,'63')
})
