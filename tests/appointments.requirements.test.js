const test=require('node:test'),assert=require('node:assert/strict')
const {parseAssignmentRequirements,resolveAssignmentRequirements,publicAssignmentRequirements}=require('../src/modules/appointments/domain/assignmentRequirements')
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const req=(n,optionIds,quantity=1,kind='PROVIDER')=>({id:id(n),kind,name:`Requisito ${n}`,quantity,optionIds})
const candidates=[1,2,3].map(n=>({id:id(n),kind:'PROVIDER'}))
test('overlapping options find a complete matching instead of greedily stealing the only candidate',()=>{
 const requirements=[req(10,[id(1),id(2)]),req(11,[id(1)])]
 const out=resolveAssignmentRequirements({requirements,candidates})
 assert.deepEqual(out.assignments,[{requirementId:id(10),entityIds:[id(2)]},{requirementId:id(11),entityIds:[id(1)]}])
 assert.deepEqual(out.selectedIds,[id(1),id(2)])
 assert.deepEqual(resolveAssignmentRequirements({requirements:[...requirements].reverse(),candidates:[...candidates].reverse()}),out)
})
test('aliases of one person cannot fill two required places',()=>{
 const out=resolveAssignmentRequirements({requirements:[req(10,[id(1),id(2)],2)],candidates,identityById:new Map([[id(1),'person-a'],[id(2),'person-a']])})
 assert.equal(out,null)
 assert.ok(resolveAssignmentRequirements({requirements:[req(10,[id(1),id(2),id(3)],2)],candidates,identityById:new Map([[id(1),'person-a'],[id(2),'person-a'],[id(3),'person-b']])}))
})
test('explicit selection is neither replaced nor extended and eligible extras are retained',()=>{
 const requirements=[req(10,[id(1),id(2)],2)]
 assert.equal(resolveAssignmentRequirements({requirements,candidates,selectedIds:[id(1)]}),null)
 assert.equal(resolveAssignmentRequirements({requirements,candidates,selectedIds:[]}),null)
 assert.equal(resolveAssignmentRequirements({requirements,candidates,selectedIds:[id(1),id(2),id(999)]}),null)
 assert.deepEqual(resolveAssignmentRequirements({requirements,candidates,selectedIds:[id(1),id(2),id(3)]}).selectedIds,[id(1),id(2),id(3)])
})
test('resource capacity or a professional of another kind does not satisfy missing physical units',()=>{
 assert.equal(resolveAssignmentRequirements({requirements:[req(10,[id(1)],2,'RESOURCE')],candidates:[{id:id(1),kind:'RESOURCE',person_capacity:100}]}),null)
 assert.equal(resolveAssignmentRequirements({requirements:[req(10,[id(1)],1,'RESOURCE')],candidates}),null)
})
test('requirements reject malformed or oversized closed input and normalize valid input',()=>{
 const valid=req(10,[id(2),id(1)])
 assert.deepEqual(parseAssignmentRequirements([valid]),[{...valid,optionIds:[id(1),id(2)]}])
 assert.deepEqual(parseAssignmentRequirements(undefined),[])
 for(const raw of [null,{},[{...valid,quantity:0}],[{...valid,quantity:21}],[{...valid,quantity:1.5}],[{...valid,kind:'ANY'}],[{...valid,optionIds:[]}],[{...valid,optionIds:[id(1),id(1)]}],[{...valid,optionIds:['bad']}],[{...valid,name:'x'.repeat(101)}],[{...valid,script:'x'}],[valid,valid],Array.from({length:21},(_,i)=>req(100+i,[id(1)])),[req(10,[id(1)],20),req(11,[id(2)],20),req(12,[id(3)])]]){
  assert.throws(()=>parseAssignmentRequirements(raw),error=>error.status===400&&error.code==='INVALID_INPUT')
 }
 assert.throws(()=>parseAssignmentRequirements(Array.from({length:20},(_,i)=>req(100+i,Array.from({length:100},(_,j)=>id(j+1000)),2))),{code:'INVALID_INPUT'})
})
test('public requirement summary has no option IDs or directory data',()=>{
 assert.deepEqual(publicAssignmentRequirements([req(10,[id(1),id(2)],2)]),[{name:'Requisito 10',kind:'PROVIDER',quantity:2}])
})
test('bounded large matching can fill forty distinct places without enumerating combinations',()=>{
 const people=Array.from({length:100},(_,i)=>({id:id(i+100),kind:'PROVIDER'}))
 const requirements=[req(10,people.map(p=>p.id),20),req(11,people.map(p=>p.id),20)]
 const out=resolveAssignmentRequirements({requirements,candidates:people})
 assert.equal(out.assignments.reduce((n,r)=>n+r.entityIds.length,0),40)
 assert.equal(new Set(out.selectedIds).size,40)
})
