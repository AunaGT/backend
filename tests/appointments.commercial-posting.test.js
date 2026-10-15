const test=require('node:test'),assert=require('node:assert/strict')
let buildEngagementPosting
try{({buildEngagementPosting}=require('../src/services/accounting/engagementPosting'))}catch(e){if(e.code!=='MODULE_NOT_FOUND')throw e}
const accounts={cash:1,bank:2,receivables:3,customerAdvances:4}
test('malformed account mappings report actionable configuration errors',async()=>{
  const {getEngagementAccounts}=require('../src/services/accounting/core')
  for(const value of ['null','[]','not-json'])await assert.rejects(()=>getEngagementAccounts({systemSetting:{findFirst:async()=>({value})},account:{findMany:async()=>[]}},'company'),{code:'ACCOUNTING_SETUP_REQUIRED'})
})
test('advance application is a non-cash reclassification, not another receipt or income',()=>{
  assert.equal(typeof buildEngagementPosting,'function')
  assert.deepEqual(buildEngagementPosting({kind:'APPLY',amount:'40.00'},accounts),[{account_id:4,debit:40,credit:0},{account_id:3,debit:0,credit:40}])
})
test('receipt and effective refund use the cash/bank counterparty and preserve exact cents',()=>{
  assert.equal(typeof buildEngagementPosting,'function')
  assert.deepEqual(buildEngagementPosting({kind:'RECEIVE',amount:'0.30',isCash:true},accounts),[{account_id:1,debit:0.3,credit:0},{account_id:4,debit:0,credit:0.3}])
  assert.deepEqual(buildEngagementPosting({kind:'REFUND',amount:'10.00',isCash:false},accounts),[{account_id:4,debit:10,credit:0},{account_id:2,debit:0,credit:10}])
  for(const value of ['0','-1','0.001','NaN'])assert.throws(()=>buildEngagementPosting({kind:'RECEIVE',amount:value},accounts))
  assert.throws(()=>buildEngagementPosting({kind:'UNKNOWN',amount:'1.00'},accounts))
})
