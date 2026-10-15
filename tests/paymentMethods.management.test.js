const test=require('node:test'),assert=require('node:assert/strict')
const {createCompanyPaymentMethod,updateCompanyPaymentMethod,deleteCompanyPaymentMethod}=require('../src/services/paymentMethods/management')
function fixture({owner='A',used=0,other=1,enabled=true,collision=false}={}){
  const m={id:7,name:'Mostrador',company_id:owner,is_credit:false,settlement_kind:'CASH',_count:{sales:used}}
  const pref={company_id:'A',enabled,position:0,payment_method:m}
  const tx={$executeRaw:async()=>0,paymentMethod:{findFirst:async()=>m,
    update:async({data})=>Object.assign(m,data),create:async({data})=>({id:8,...data}),delete:async()=>{}},
    companyPaymentMethod:{findFirst:async()=>pref,findMany:async()=>collision?[{payment_method:{id:9,name:' MOSTRADOR '}}]:[],count:async()=>other,
      aggregate:async()=>({_max:{position:4}}),create:async({data})=>({...data,payment_method:{id:8,name:'Mostrador',company_id:'A',is_credit:false,settlement_kind:'CASH'}}),
      update:async({data})=>Object.assign(pref,data),delete:async()=>{}}}
  return {tx,db:{$transaction:async run=>run(tx)}}
}
test('shared method names and deletion stay protected',async()=>{
  const {db}=fixture({owner:null})
  await assert.rejects(updateCompanyPaymentMethod(db,'A',7,{name:'Nuevo'}),e=>e.code==='PM_SHARED_PROTECTED')
  await assert.rejects(deleteCompanyPaymentMethod(db,'A',7),e=>e.code==='PM_SHARED_PROTECTED')
})
test('used private methods cannot rename or delete',async()=>{
  const {db}=fixture({used:1})
  await assert.rejects(updateCompanyPaymentMethod(db,'A',7,{name:'Nuevo'}),e=>e.code==='PM_IN_USE')
  await assert.rejects(deleteCompanyPaymentMethod(db,'A',7),e=>e.code==='PM_IN_USE')
})
test('last effective method cannot be disabled or deleted',async()=>{
  const {db}=fixture({other:0})
  await assert.rejects(updateCompanyPaymentMethod(db,'A',7,{enabled:false}),e=>e.code==='PM_LAST_EFFECTIVE')
  await assert.rejects(deleteCompanyPaymentMethod(db,'A',7),e=>e.code==='PM_LAST_EFFECTIVE')
})
test('create and reactivation detect normalized active collisions',async()=>{
  const {db}=fixture({collision:true,enabled:false})
  await assert.rejects(createCompanyPaymentMethod(db,'A',{name:'Mostrador',settlement_kind:'CASH'}),e=>e.code==='PM_NAME_CONFLICT')
  await assert.rejects(updateCompanyPaymentMethod(db,'A',7,{enabled:true}),e=>e.code==='PM_NAME_CONFLICT')
})
test('owner/type cannot be injected or changed',async()=>{
  for(const body of [{settlement_kind:'BANK'},{companyId:'B'},{is_credit:true},{enabled:'false'},{position:-1}])
    await assert.rejects(updateCompanyPaymentMethod(fixture().db,'A',7,body),e=>e.status===400)
})
test('private creation derives credit flag, ownership and order',async()=>{
  const {db,tx}=fixture();let stored
  tx.paymentMethod.create=async({data})=>{stored=data;return {id:8,...data}}
  const result=await createCompanyPaymentMethod(db,'A',{name:'  Mostrador ',settlement_kind:'CREDIT'})
  assert.deepEqual(stored,{company_id:'A',name:'Mostrador',settlement_kind:'CREDIT',is_credit:true})
  assert.equal(result.id,8);assert.equal(result.position,5)
})
