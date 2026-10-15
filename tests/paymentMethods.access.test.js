const test=require('node:test'),assert=require('node:assert/strict')
const {resolvePaymentMethod,listPaymentMethodChoices,findHistoricalPaymentMethod,firstActiveCreditMethod,lockPaymentMethods}=require('../src/services/paymentMethods/access')
function txFor(method={},enabled=true){return {$executeRaw:async()=>0,companyPaymentMethod:{
  findFirst:async({where})=>{assert.equal(where.company_id,'A');return {enabled,payment_method:{id:7,name:'Medio',company_id:null,is_credit:false,...method}}},
}}}
test('disabled new money is rejected but historical identity remains readable',async()=>{
  await assert.rejects(resolvePaymentMethod(txFor({},false),{companyId:'A',methodId:7,purpose:'RECEIPT'}),e=>e.code==='PM_DISABLED')
  assert.equal((await findHistoricalPaymentMethod(txFor({},false),'A',7)).id,7)
})
test('alien owner and missing preference are indistinguishable',async()=>{
  await assert.rejects(resolvePaymentMethod(txFor({company_id:'B'}),{companyId:'A',methodId:7,purpose:'SALE'}),e=>e.code==='PM_NOT_FOUND'&&e.status===404)
  await assert.rejects(resolvePaymentMethod({$executeRaw:async()=>0,companyPaymentMethod:{findFirst:async()=>null}},{companyId:'A',methodId:7,purpose:'SALE'}),e=>e.code==='PM_NOT_FOUND')
})
test('invalid tenant and malformed IDs fail before database access',async()=>{
  const tx={$executeRaw:async()=>{throw Error('unexpected DB access')}}
  await assert.rejects(resolvePaymentMethod(tx,{companyId:'',methodId:7,purpose:'SALE'}),e=>e.status===403)
  for(const id of [-1,0,1.5,'7x',true,[],2147483648])await assert.rejects(resolvePaymentMethod(tx,{companyId:'A',methodId:id,purpose:'SALE'}),e=>e.status===400)
})
for(const credit of [false,true])for(const purpose of ['SALE','CREDIT_SALE','RECEIPT','SUPPLIER_PAYMENT','REFUND']){
  test(`purpose ${purpose} with credit=${credit}`,async()=>{
    const call=resolvePaymentMethod(txFor({is_credit:credit}),{companyId:'A',methodId:'7',purpose})
    const allowed=purpose==='SALE'||(purpose==='CREDIT_SALE'?credit:!credit)
    if(allowed)assert.equal((await call).id,7);else await assert.rejects(call,e=>e.code==='PM_KIND_INVALID')
  })
}
test('selector never falls back to global catalog when company has no preferences',async()=>{
  const db={companyPaymentMethod:{findMany:async()=>[],count:async()=>0}}
  await assert.rejects(listPaymentMethodChoices(db,'A',{}),e=>e.code==='PM_SETUP_REQUIRED')
})
test('selector projects stable ID and excludes inactive unless historical',async()=>{
  const db={companyPaymentMethod:{findMany:async({where})=>{
    assert.equal(where.company_id,'A');return [{enabled:true,position:4,payment_method:{id:7,name:'Cash',is_credit:false,settlement_kind:'CASH',base_code:'CASH'}}]
  }}}
  const [row]=await listPaymentMethodChoices(db,'A',{})
  assert.deepEqual(row,{id:7,name:'Cash',is_credit:false,settlement_kind:'CASH',enabled:true,position:4,origin:'BASIC'})
})
test('credit auto selection fails actionably when unavailable',async()=>{
  await assert.rejects(firstActiveCreditMethod({$executeRaw:async()=>0,companyPaymentMethod:{findFirst:async()=>null}},'A'),e=>e.code==='PM_KIND_INVALID')
})
