const test = require('node:test')
const assert = require('node:assert/strict')
const { inspectPaymentMethodBasics, ensurePaymentMethodBasics } = require('../src/services/paymentMethods/basics')
test('rejects contradictory credit without rewriting financial meaning', () => {
  assert.throws(() => inspectPaymentMethodBasics([{ id:1,name:'Crédito',is_credit:false }]), e => e.code==='PM_SETUP_REQUIRED')
})
test('legacy names do not acquire inferred ownership or type', () => {
  const result=inspectPaymentMethodBasics([{id:42,name:'Depósito especial',is_credit:false}])
  assert.equal(result.byCode.size,0)
  assert.deepEqual(result.missing,['CASH','CARD','TRANSFER','CREDIT'])
})
test('ambiguous shared names and noncanonical basic whitespace fail preparation', () => {
  for(const rows of [[{id:1,name:'Efectivo',is_credit:false},{id:2,name:' efectivo ',is_credit:false}], [{id:1,name:' Efectivo',is_credit:false}]])
    assert.throws(()=>inspectPaymentMethodBasics(rows),e=>e.code==='PM_SETUP_REQUIRED')
})
test('inconsistent existing metadata fails instead of being repaired', () => {
  assert.throws(()=>inspectPaymentMethodBasics([{id:1,name:'Tarjeta',is_credit:false,base_code:'CASH',settlement_kind:'CASH'}]),e=>e.code==='PM_SETUP_REQUIRED')
})
test('controlled initialization is idempotent and never changes old names or flags', async () => {
  const rows=[{id:6,name:'Efectivo',is_credit:false}]; const writes=[]
  const tx={$executeRaw:async()=>0,paymentMethod:{findMany:async()=>rows,
    update:async({where,data})=>{writes.push(data);Object.assign(rows.find(r=>r.id===where.id),data)},
    create:async({data})=>{rows.push({id:rows.length+10,...data});return rows.at(-1)}}}
  await ensurePaymentMethodBasics(tx);await ensurePaymentMethodBasics(tx)
  assert.equal(rows.length,4);assert.equal(rows[0].id,6);assert.equal(rows[0].name,'Efectivo')
  assert.deepEqual(writes,[{base_code:'CASH',settlement_kind:'CASH'}])
})
