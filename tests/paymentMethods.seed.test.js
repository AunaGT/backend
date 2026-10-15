const test=require('node:test'),assert=require('node:assert/strict')
const {seedCompanyPaymentMethods}=require('../src/services/paymentMethods/seed')
test('repeated company seed preserves disabled state/order and adds basics only',async()=>{
  const rows=[{company_id:'A',payment_method_id:1,enabled:false,position:8}]
  const tx={paymentMethod:{findMany:async({where})=>{
    assert.equal(where.company_id,null);assert.deepEqual(where.base_code.in,['CASH','CARD','TRANSFER','CREDIT'])
    return ['CASH','CARD','TRANSFER','CREDIT'].map((base_code,i)=>({id:i+1,base_code}))}},
    companyPaymentMethod:{createMany:async({data,skipDuplicates})=>{
      assert.equal(skipDuplicates,true)
      for(const r of data)if(!rows.some(x=>x.company_id===r.company_id&&x.payment_method_id===r.payment_method_id))rows.push(r)
    }}}
  await seedCompanyPaymentMethods(tx,'A');await seedCompanyPaymentMethods(tx,'A');await seedCompanyPaymentMethods(tx,'B')
  assert.equal(rows.length,8);assert.equal(rows[0].enabled,false);assert.equal(rows[0].position,8)
  assert.deepEqual(rows.filter(r=>r.company_id==='B').map(r=>r.payment_method_id),[1,2,3,4])
})
test('missing basics fail closed without creating partial preferences',async()=>{
  await assert.rejects(seedCompanyPaymentMethods({paymentMethod:{findMany:async()=>[]}},'A'),e=>e.code==='PM_SETUP_REQUIRED')
})
