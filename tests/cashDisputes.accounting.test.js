const test=require('node:test'),assert=require('node:assert/strict')
const {buildDisputeEffectLines,buildDisputeDispositionLines}=require('../src/services/accounting/cashDisputePosting')
const a={dispute:1,funding:2,fee:3}
test('a bank withdrawal posts principal to dispute assets and its fee separately without charging the customer',()=>{
  assert.deepEqual(buildDisputeEffectLines({kind:'BANK_DEBIT',principal:'100',fee:'5'},a),[
    {account_id:1,debit:'100.00',credit:'0.00'},{account_id:2,debit:'0.00',credit:'105.00'},{account_id:3,debit:'5.00',credit:'0.00'}])
})
test('recovery credits undisposed funds before the exact disposed destinations, without inventing sales or VAT',()=>{
  assert.deepEqual(buildDisputeEffectLines({kind:'BANK_RECOVERY',principal:'50',fee:'0'},a,[{amount:'10',accountId:4}]),[
    {account_id:1,debit:'0.00',credit:'40.00'},{account_id:2,debit:'50.00',credit:'0.00'},{account_id:4,debit:'0.00',credit:'10.00'}])
  assert.throws(()=>buildDisputeEffectLines({kind:'BANK_RECOVERY',principal:'5',fee:'0'},a,[{amount:'6',accountId:4}]),{code:'DISPUTE_ACCOUNTING_PROVENANCE'})
})
test('mixed disposition debits advances, receivables and the merchant loss exactly once',()=>{
  assert.deepEqual(buildDisputeDispositionLines([{kind:'RECEIPT_RETIRED',principal:'40',accountId:4},{kind:'CUSTOMER_CHARGE',principal:'50',accountId:5},{kind:'ABSORBED',principal:'10',accountId:6}],1),[
    {account_id:1,debit:'0.00',credit:'100.00'},{account_id:4,debit:'40.00',credit:'0.00'},{account_id:5,debit:'50.00',credit:'0.00'},{account_id:6,debit:'10.00',credit:'0.00'}])
})
test('forgiving a customer charge reclassifies that debt to a loss without another bank entry',()=>{
  assert.deepEqual(buildDisputeDispositionLines([{kind:'COMPENSATED',principal:'40',accountId:5},{kind:'ABSORBED',principal:'40',accountId:6}],1),[
    {account_id:5,debit:'0.00',credit:'40.00'},{account_id:6,debit:'40.00',credit:'0.00'}])
  assert.throws(()=>buildDisputeDispositionLines([{kind:'ABSORBED',principal:'10',accountId:null}],1),{code:'DISPUTE_ACCOUNTING_PROVENANCE'})
})
