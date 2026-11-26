const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto')
const ID='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',BRANCH='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',COMPANY='cccccccc-cccc-4ccc-8ccc-cccccccccccc'
function helpers(){return require('../src/services/commercialDocumentConcurrency')}
test('tenant document lock reads only after waiting and rejects missing or changed revision',async()=>{
 const {lockCommercialDocument,assertDocumentUnchanged}=helpers(),events=[],revision=randomUUID()
 const current={id:ID,integration_revision:revision,status:'DRAFT',branch_id:BRANCH}
 const db={$queryRaw:async(strings,...values)=>{events.push('lock');assert.match(strings.join(''),/FOR UPDATE OF d/);assert.ok(values.includes(COMPANY));return[{id:ID}]},commercialDocument:{findFirst:async({where})=>{events.push('read');assert.deepEqual(where,{id:ID,doc_type:'QUOTE',branch_id:BRANCH,branch:{company_id:COMPANY}});return current}}}
 assert.equal(await lockCommercialDocument(db,{companyId:COMPANY,branchId:BRANCH,type:'QUOTE'},ID),current)
 assert.deepEqual(events,['lock','read']);assert.doesNotThrow(()=>assertDocumentUnchanged(current,revision))
 for(const row of [null,{...current,integration_revision:randomUUID()},{...current,integration_revision:undefined}])assert.throws(()=>assertDocumentUnchanged(row,revision),{status:409,code:'DOCUMENT_CHANGED'})
 assert.throws(()=>assertDocumentUnchanged(current,undefined),{status:409,code:'DOCUMENT_CHANGED'})
})
function loadController(t,type,baseline,current){
 const controllerPath=require.resolve(`../src/modules/${type}/controller`),modelPath=require.resolve('../src/models/prisma'),oldModel=require.cache[modelPath],oldController=require.cache[controllerPath]
 let writes=0,effects=0
 const tx={$queryRaw:async()=>[{id:ID}],commercialDocument:{findFirst:async()=>current,update:async()=>{writes++;return current}},commercialDocumentLine:{deleteMany:async()=>{writes++}},supplier:{findFirst:async()=>{effects++;return null}},systemSetting:{findMany:async()=>{effects++;return[]}}}
 require.cache[modelPath]={exports:{prisma:{commercialDocument:{findFirst:async()=>baseline}},prismaTransaction:{$transaction:async fn=>fn(tx)}}};delete require.cache[controllerPath]
 const controller=require(controllerPath)
 t.after(()=>{if(oldModel)require.cache[modelPath]=oldModel;else delete require.cache[modelPath];if(oldController)require.cache[controllerPath]=oldController;else delete require.cache[controllerPath]})
 return{controller,counts:()=>({writes,effects})}
}
const request=body=>({companyId:COMPANY,branchId:BRANCH,branchIds:[BRANCH,ID],userBranchIds:[BRANCH,ID],user:{sub:ID},params:{id:ID},body})
const response=()=>({status(){return this},json(){}})
for(const type of ['quotes','orders'])test(`internal ${type} edit cannot replace lines after API cancel`,async t=>{
 const baseline={id:ID,status:'DRAFT',branch_id:BRANCH,doc_type:type==='quotes'?'QUOTE':'ORDER',integration_revision:randomUUID(),sales_channel:'ONLINE'}
 const f=loadController(t,type,baseline,{...baseline,status:'CANCELLED',integration_revision:randomUUID()});let error
 await f.controller.update(request({items:[]}),response(),e=>{error=e})
 assert.equal(error?.code,'DOCUMENT_CHANGED');assert.deepEqual(f.counts(),{writes:0,effects:0})
})
test('internal payment-only quote update checks revision before changing terms',async t=>{
 const baseline={id:ID,status:'DRAFT',branch_id:BRANCH,integration_revision:randomUUID()}
 const f=loadController(t,'quotes',baseline,{...baseline,integration_revision:randomUUID()});let error
 await f.controller.update(request({payment_condition:'CASH'}),response(),e=>{error=e})
 assert.equal(error?.code,'DOCUMENT_CHANGED');assert.deepEqual(f.counts(),{writes:0,effects:0})
})
test('internal quote status checks fresh revision before soft hold or release',async t=>{
 const baseline={id:ID,status:'DRAFT',branch_id:BRANCH,integration_revision:randomUUID(),_count:{lines:1}}
 const f=loadController(t,'quotes',baseline,{...baseline,status:'CANCELLED',integration_revision:randomUUID()});let error
 await f.controller.updateStatus(request({status:'SENT'}),response(),e=>{error=e})
 assert.equal(error?.code,'DOCUMENT_CHANGED');assert.deepEqual(f.counts(),{writes:0,effects:0})
})
test('internal branch move cannot use a stale draft before allocating a reference',async t=>{
 const baseline={id:ID,status:'DRAFT',branch_id:BRANCH,integration_revision:randomUUID()}
 const f=loadController(t,'orders',baseline,{...baseline,status:'CANCELLED',integration_revision:randomUUID()});let error
 await f.controller.changeBranch(request({branch_id:ID}),response(),e=>{error=e})
 assert.equal(error?.code,'DOCUMENT_CHANGED');assert.deepEqual(f.counts(),{writes:0,effects:0})
})
