const test=require('node:test'),assert=require('node:assert/strict')
const {resolveEngagementSettlementMethod}=require('../src/services/paymentMethods/engagementSettlement')
const scope={companyId:'A',branchId:'B'},e={id:'E',company_id:'A',branch_id:'B',customer_id:'C'}
function fixture(ids){const rows=ids.map((id,i)=>({id:`commit-${i}`,company_id:'A',branch_id:'B',customer_id:'C',engagement_id:'E',state:'COMMITTED',payment:{id:`receipt-${i}`,branch_id:'B',customer_id:'C',payment_method_id:id}}))
  return {rows,tx:{$executeRaw:async()=>0,paymentCommitment:{findMany:async({where})=>{assert.equal(where.company_id,'A');assert.equal(where.customer_id,'C');assert.equal(where.state,'COMMITTED');return rows}},
    companyPaymentMethod:{findFirst:async({where})=>({enabled:false,payment_method:{id:where.payment_method_id,company_id:null,is_credit:false}})}}}}
for(const [ids,want] of [[[11,11],11],[[11,12],null],[[11,null],null],[[],null]])test(`fully paid receipts ${JSON.stringify(ids)} preserve real identity`,async()=>{
  assert.equal(await resolveEngagementSettlementMethod(fixture(ids).tx,scope,e,'0.00'),want)
})
test('pending balance chooses only scoped active credit and fails when unavailable',async()=>{
  const f=fixture([])
  f.tx.companyPaymentMethod.findFirst=async({where})=>{assert.equal(where.enabled,true);assert.equal(where.payment_method.is_credit,true);return {enabled:true,payment_method:{id:9,is_credit:true,company_id:null}}}
  assert.equal(await resolveEngagementSettlementMethod(f.tx,scope,e,'5.00'),9)
  f.tx.companyPaymentMethod.findFirst=async()=>null
  await assert.rejects(resolveEngagementSettlementMethod(f.tx,scope,e,'5.00'),error=>error.code==='PM_KIND_INVALID')
})
test('foreign receipt cannot determine settlement identity even from corrupt projection',async()=>{
  const f=fixture([11]);f.rows[0].payment.branch_id='FOREIGN'
  await assert.rejects(resolveEngagementSettlementMethod(f.tx,scope,e,'0.00'),error=>error.code==='PM_NOT_FOUND')
})
