const test=require('node:test'),assert=require('node:assert/strict')
let commercialState,confirmedSaleWhere
try{({commercialState,confirmedSaleWhere}=require('../src/modules/sales/commercialState'))}catch(e){if(e.code!=='MODULE_NOT_FOUND')throw e}
test('confirmed criterion excludes drafts and preserves caller scope',()=>{
  assert.equal(typeof commercialState,'function')
  assert.equal(commercialState('Completada'),'CONFIRMED')
  assert.equal(commercialState('Borrador'),'DRAFT')
  assert.equal(commercialState('Cancelada'),'CANCELLED')
  assert.equal(commercialState('Pagado'),'LEGACY')
  assert.deepEqual(confirmedSaleWhere({branch_id:'b'}),{AND:[{status:{name:'Completada'}},{branch_id:'b'}]})
})
test('payment status synchronization cannot turn a draft into an applied payment',async()=>{
  const {syncSaleStatus}=require('../src/modules/receivables/domain/receivables')
  let writes=0
  const tx={sale:{findUnique:async()=>({id:'draft',status:{name:'Borrador'},adjusted_total:0,paymentEntries:[]}),update:async()=>{writes++}}}
  await assert.rejects(()=>syncSaleStatus(tx,'draft'),{code:'SALE_NOT_CONFIRMED'})
  assert.equal(writes,0)
})
