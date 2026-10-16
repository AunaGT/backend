const test=require('node:test'),assert=require('node:assert/strict')
test('install canonical baseline and payments on the same development Supabase, compare and clean exact QA schema',{
  skip:process.env.AUNA_BASELINE_DEV!=='1',timeout:900000,
},async()=>{
  require('../src/config/loadEnv')
  const result=await require('../scripts/migrations/rehearsal').runRehearsal({receiptPath:process.env.AUNA_BASELINE_RECEIPT})
  assert.equal(result.installation,true)
  assert.equal(result.qaCleaned,true)
  console.log(JSON.stringify({rehearsalReceipt:result.receipt,installation:result.installation,historyRecovery:result.historyRecovery,qaCleaned:result.qaCleaned}))
})
