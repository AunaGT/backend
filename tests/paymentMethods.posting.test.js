const test=require('node:test'),assert=require('node:assert/strict')
const {buildSalePosting,buildReturnPosting}=require('../src/services/accounting/postingEngine')
const {applyOpeningFloatToCashBreakdown,applyReturnSettlements}=require('../src/modules/cash-closure/domain')
const defaults={cash:{id:'cash-account'},bank:{id:'bank-account'},receivables:{id:'ar-account'},sales:{id:'sales-account'},salesReturns:{id:'returns-account'},inventory:{id:'inventory-account'},cogs:{id:'cogs-account'}}
const options={defaults,splitVat:false,ivaRate:0,costBase:v=>v,pequenoTaxOf:()=>0}
for(const [kind,name,account] of [['CASH','Mostrador','cash-account'],['BANK','Efectivo digital','bank-account'],[null,'Cash','bank-account'],[null,'Efectivo','cash-account']])
test(`sale and refund posting honor ${kind} ${name}`,()=>{
  const method={id:11,name,is_credit:false,settlement_kind:kind}
  const lines=buildSalePosting({total:25,settlement_source:'LEGACY',sale_items:[],payment_method:method},options)
  assert.equal(lines.find(l=>l.debit===25).account_id,account)
  const refund=buildReturnPosting({total_refund:25,type:'REFUND',return_items:[],sale:{payment_method:method},settlements:[{kind:'REFUND',amount:25,payment_method:method}]},options)
  assert.equal(refund.find(l=>l.credit===25).account_id,account)
})
test('opening float uses authorized historical cash even when disabled',async()=>{
  const map=new Map()
  const db={companyPaymentMethod:{findMany:async({where})=>{
    assert.equal(where.company_id,'A');assert.equal(where.enabled,undefined)
    return [{enabled:false,position:0,payment_method:{id:3,name:'Mostrador',company_id:'A',settlement_kind:'CASH',is_credit:false}}]
  }}}
  assert.deepEqual(await applyOpeningFloatToCashBreakdown(db,'A',map,40),{openingFloat:40,cashSalesAmount:0})
  assert.equal(map.get(3).theoretical_amount,40);assert.equal(map.get(3).settlement_kind,'CASH')
})
test('refund breakdown keeps explicit type for disabled historical medium',()=>{
  const map=new Map()
  applyReturnSettlements(map,[{kind:'REFUND',amount:10,payment_method_id:7,payment_method:{name:'Efectivo digital',settlement_kind:'BANK'}}])
  assert.equal(map.get(7).theoretical_amount,-10);assert.equal(map.get(7).settlement_kind,'BANK')
})
