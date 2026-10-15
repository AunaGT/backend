const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto')
const {prepareBarcodeLabels}=require('../src/modules/inventory/barcodeLabels/preparations')
const {createLabelTemplate,defaultPaper}=require('../src/modules/inventory/barcodeLabels/validation')
const COMPANY='11111111-1111-4111-8111-111111111111',BRANCH='22222222-2222-4222-8222-222222222222',USER='33333333-3333-4333-8333-333333333333',PRODUCT='44444444-4444-4444-8444-444444444444'
function harness(){
  let products=[{id:PRODUCT,company_id:COMPANY,name:'QA bien',kind:'STANDARD',barcode:null,deleted:false,available_for_sale:true,price:25,brand:null,size:null}],records=[],writes=[]
  const matches=(r,w)=>Object.entries(w||{}).every(([k,v])=>typeof v==='object'&&v!==null?'in'in v?v.in.includes(r[k]):'not'in v?r[k]!==v.not:true:r[k]===v)
  const db={companyModule:{findMany:async()=>[{module_code:'inventory',status:'ACTIVE'}]},company:{findUnique:async()=>({name:'QA'})},systemSetting:{findMany:async()=>[]},branch:{findFirst:async({where})=>where.id===BRANCH&&where.company_id===COMPANY?{id:BRANCH}:null},warehouse:{findFirst:async()=>null},warehouseLocation:{findFirst:async()=>null},
    product:{findMany:async({where})=>products.filter(p=>matches(p,where)),findFirst:async({where})=>products.find(p=>matches(p,where)),update:async({where,data})=>{writes.push(data);const p=products.find(p=>p.id===where.id);Object.assign(p,data);return p}},
    barcodePrintPreparation:{findUnique:async({where})=>records.find(r=>matches(r,where.company_id_actor_id_request_key)),create:async({data})=>{records.push(data);return data}},$executeRaw:async()=>0,$queryRaw:async()=>products.map(p=>({id:p.id}))}
  db.$transaction=async fn=>{const old=structuredClone({products,records,writes});try{return await fn(db)}catch(e){({products,records,writes}=old);throw e}}
  const scope={companyId:COMPANY,branchId:BRANCH,branchIds:[BRANCH],userId:USER,isAdmin:true,permissions:[]}
  const input={requestKey:crypto.randomUUID(),scope:{branchId:BRANCH,inBranch:false},items:[{productId:PRODUCT,copies:2,expectedBarcode:null,assignment:{mode:'auto'}}],design:createLabelTemplate(),paper:defaultPaper(),confirmAssignments:true}
  return{db,scope,input,products:()=>products,records:()=>records,writes:()=>writes}
}
test('confirmed assignments preserve unrelated fields and exact retry returns same snapshot',async()=>{
  const h=harness(),a=await prepareBarcodeLabels(h.db,h.scope,h.input),b=await prepareBarcodeLabels(h.db,h.scope,h.input)
  assert.deepEqual(a,b);assert.equal(h.records().length,1);assert.match(a.products[0].barcode,/^AUNA[0-9A-F]{12}$/)
  assert.deepEqual(Object.keys(h.writes()[0]),['barcode']);assert.equal(h.products()[0].price,25)
  await assert.rejects(()=>prepareBarcodeLabels(h.db,h.scope,{...h.input,items:[{...h.input.items[0],copies:3}]}),e=>e.status===409)
})
test('missing edit permission, stale existing code and service reject without writes',async()=>{
  const h=harness()
  await assert.rejects(()=>prepareBarcodeLabels(h.db,{...h.scope,isAdmin:false,permissions:['products.view','products.export']},h.input),e=>e.status===403)
  h.products()[0].barcode='EXISTING'
  await assert.rejects(()=>prepareBarcodeLabels(h.db,h.scope,h.input),e=>e.status===409)
  h.products()[0].barcode=null;h.products()[0].kind='SERVICE'
  await assert.rejects(()=>prepareBarcodeLabels(h.db,h.scope,h.input),e=>e.status===404)
  assert.equal(h.records().length,0);assert.equal(h.writes().length,0)
})
test('a foreign branch is refused even with edit permission',async()=>{
  const h=harness();await assert.rejects(()=>prepareBarcodeLabels(h.db,h.scope,{...h.input,scope:{branchId:crypto.randomUUID(),inBranch:false}}),e=>e.status===403)
})
test('an automatic code collision retries before any successful assignment is committed',async()=>{
  const h=harness(),original=crypto.randomBytes;let tries=0
  h.products().push({...h.products()[0],id:'55555555-5555-4555-8555-555555555555',barcode:'AUNA000000000000'})
  crypto.randomBytes=()=>{tries++;return Buffer.alloc(6,tries===1?0:1)}
  try{const result=await prepareBarcodeLabels(h.db,h.scope,h.input);assert.equal(result.products[0].barcode,'AUNA010101010101');assert.equal(h.records().length,1);assert.equal(h.writes().length,1)}finally{crypto.randomBytes=original}
})
