const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto')
const {prepareBarcodeLabels}=require('../src/modules/inventory/barcodeLabels/preparations')
const {prepareShelfLabels}=require('../src/modules/inventory/barcodeLabels/shelfPrices')
const {createLabelTemplate,createShelfLabelTemplate,defaultPaper,parsePreparationInput}=require('../src/modules/inventory/barcodeLabels/validation')
const {matches,project}=require('./helpers/labelReadFixture.cjs')
const C='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222',U='33333333-3333-4333-8333-333333333333',P='44444444-4444-4444-8444-444444444444',R='55555555-5555-4555-8555-555555555555'
function harness(){
 const product={id:P,company_id:C,name:'Aceite',kind:'STANDARD',unit_metadata_version:2,barcode:'BASE',base_unit_id:'unit',quantity_decimals:6,unit_revision:3,price:'0.123456',price_wholesale:'0.1',price_promotion:null,brand:null,size:null}
 const presentation={id:R,company_id:C,product_id:P,active:true,sale_enabled:true,label:'caja',name:'Caja24',factor:'24',quantity_decimals:0,version:1,price:null,price_wholesale:'2.25',price_promotion:null}
 const codes=[],records=[],writes=[]
 const db={companyModule:{findMany:async()=>[{module_code:'inventory',status:'ACTIVE'}]},company:{findUnique:async()=>({name:'QA'})},branch:{findFirst:async()=>({id:B})},systemSetting:{findUnique:async()=>({key:'inventory_units_enabled',value:'true'}),findMany:async()=>[]},product:{findMany:async()=>[product],findFirst:async({where})=>where.barcode?null:product,update:async args=>writes.push(args)},measureUnit:{findFirst:async()=>({id:'unit',code:'L',name:'Litro',label:'L'})},productPresentation:{findFirst:async({where})=>presentation.active&&where.id===R&&where.company_id===C?presentation:null},productBarcode:{findMany:async()=>codes,findFirst:async({where})=>codes.find(c=>c.code===where.code),create:async({data})=>{codes.push({id:'code',...data});return data},update:async()=>{}},barcodePrintPreparation:{findUnique:async()=>records[0],create:async({data})=>{records.push(data);return data}},$executeRaw:async()=>0,$queryRaw:async()=>[]}
 db.measureUnit.findMany=async q=>[{id:'unit',company_id:C,code:'L',name:'Litro',label:'L'}].filter(row=>matches(row,q.where)).map(row=>project(row,q.select))
 db.productPresentation.findMany=async q=>[presentation].filter(row=>matches(row,q.where)).map(row=>project(row,q.select))
 db.productBarcode.findMany=async q=>codes.filter(row=>matches(row,q.where)).map(row=>project(row,q.select))
 db.$transaction=async fn=>fn(db)
 const scope={companyId:C,branchId:B,branchIds:[B],userId:U,isAdmin:true}
 const item={productId:P,presentation_id:R,unit_revision:3,copies:2,expectedBarcode:null,assignment:{mode:'auto'}}
 const input={requestKey:crypto.randomUUID(),scope:{branchId:B,inBranch:false},items:[item],design:createLabelTemplate('price'),paper:defaultPaper(),confirmAssignments:true}
 return{db,scope,input,product,presentation,codes,records,writes}
}
test('label contract uses product+presentation identity and copies remain strict integers',()=>{
 const h=harness();assert.equal(parsePreparationInput({...h.input,items:[h.input.items[0],{...h.input.items[0],presentation_id:null,expectedBarcode:'BASE',assignment:{mode:'keep'}}]}).items.length,2)
 assert.throws(()=>parsePreparationInput({...h.input,items:[{...h.input.items[0],copies:1.5}]}),/copies/)
})
test('flag-off base barcode label assignment keeps the normalized registry authoritative',async()=>{
 const h=harness();h.product.unit_metadata_version=1;h.product.barcode=null
 h.db.systemSetting.findUnique=async()=>({key:'inventory_units_enabled',value:'false'})
 h.db.productBarcode.updateMany=async()=>({count:0})
 h.input.items=[{productId:P,copies:1,expectedBarcode:null,assignment:{mode:'manual',value:'NEWBASE'}}]
 await prepareBarcodeLabels(h.db,h.scope,h.input)
 assert.equal(h.writes[0].data.barcode,'NEWBASE')
 assert.equal(h.codes[0]?.code,'NEWBASE');assert.equal(h.codes[0]?.presentation_id,null)
 assert.equal(h.product.unit_metadata_version,1)
})
test('selected barcode preparation freezes v2 exact price/unit and only reserves presentation code',async()=>{
 const h=harness(),snapshot=await prepareBarcodeLabels(h.db,h.scope,h.input)
 assert.equal(snapshot.snapshotVersion,2);assert.equal(snapshot.products[0].presentation_id,R);assert.equal(snapshot.products[0].price,'2.962944');assert.match(snapshot.products[0].name,/caja/);assert.equal(snapshot.products[0].unit_snapshot.factor,'24')
 assert.equal(h.writes.length,0);assert.equal(h.product.barcode,'BASE');assert.equal(h.codes[0].presentation_id,R)
 h.presentation.factor='999';h.presentation.active=false;h.product.unit_revision=9
 assert.deepEqual(await prepareBarcodeLabels(h.db,h.scope,h.input),snapshot,'replay returns frozen preparation without current unit resolution')
})
test('inactive foreign or stale presentation rejects before any code/job write',async()=>{
 for(const mutate of [h=>{h.presentation.active=false},h=>{h.input.items[0].presentation_id=crypto.randomUUID()},h=>{h.input.items[0].unit_revision=2}]){
  const h=harness();mutate(h);await assert.rejects(()=>prepareBarcodeLabels(h.db,h.scope,h.input),e=>[404,409].includes(e.status));assert.equal(h.codes.length,0);assert.equal(h.records.length,0);assert.equal(h.writes.length,0)
 }
})
test('shelf selected per-tier override/derived price freezes separately from base',async()=>{
 const h=harness();h.codes.push({company_id:C,code:'BOX',product_id:P,presentation_id:R,active:true})
 const input={...h.input,design:createShelfLabelTemplate(),items:[{...h.input.items[0],assignment:{mode:'keep'},expectedBarcode:'BOX',priceTiers:['LIST','WHOLESALE']},{productId:P,presentation_id:null,unit_revision:3,copies:1,expectedBarcode:'BASE',assignment:{mode:'keep'},priceTiers:['LIST']}]}
 const snapshot=await prepareShelfLabels(h.db,h.scope,input)
 assert.equal(snapshot.products.length,2);assert.deepEqual(snapshot.products[0].shelfPrices.map(p=>p.amount),['2.962944','2.25']);assert.equal(snapshot.products[0].barcode,'BOX');assert.equal(snapshot.products[1].price,'0.123456')
 h.presentation.factor='999';assert.deepEqual(await prepareShelfLabels(h.db,h.scope,input),snapshot)
})
test('expired presentation promotion inherits both active base amount and its expiry in frozen shelf labels',async()=>{
 const h=harness();h.presentation.factor='7';h.presentation.price_promotion='1';h.presentation.promotion_valid_until='2000-01-01T00:00:00.000Z';h.product.price_promotion='2';h.product.promotion_valid_until='2099-01-01T00:00:00.000Z';h.codes.push({company_id:C,code:'BOX',product_id:P,presentation_id:R,active:true})
 const design={...createShelfLabelTemplate(),priceTiers:['PROMOTION'],primaryTier:'PROMOTION'},input={...h.input,design,items:[{...h.input.items[0],assignment:{mode:'keep'},expectedBarcode:'BOX',priceTiers:['PROMOTION']}]}
 const snapshot=await prepareShelfLabels(h.db,h.scope,input)
 assert.equal(snapshot.products[0].shelfPrices[0].amount,'14');assert.equal(snapshot.products[0].promotionValidUntil,h.product.promotion_valid_until)
 h.product.price_promotion='3';h.product.promotion_valid_until='2000-01-01';assert.deepEqual(await prepareShelfLabels(h.db,h.scope,input),snapshot)
})
