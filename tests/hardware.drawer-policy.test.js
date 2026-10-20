const test=require('node:test'),assert=require('node:assert/strict')
const p=()=>require('../src/modules/config/hardware/drawer/policy')
test('only classified positive cash with open session, enabled origin and active route is eligible',()=>{
 const base={policy:p().DEFAULT_POLICY,origin:'POS_SALE',settlementKind:'CASH',amount:'0.01',sessionOpen:true,routeActive:true}
 assert.equal(p().drawerEligibility(base).eligible,true)
 for(const patch of [{amount:'0'},{amount:'-1'},{settlementKind:null},{settlementKind:'CARD'},{sessionOpen:false},{routeActive:false},{origin:'AGENDA_RECEIPT'}])assert.equal(p().drawerEligibility({...base,...patch}).eligible,false)
 assert.equal(p().drawerEligibility({...base,amount:'9999999999.99'}).eligible,true)
})
test('policy rejects unknown and non-boolean options without inferring cash from labels',()=>{
 const value={expectedVersion:0,...Object.fromEntries(['posCashSale','initialCreditReceipt','receivableReceipt','agendaReceipt','cashReturn'].map(k=>[k,true]))}
 assert.equal(p().validateDrawerPolicy(value).agendaReceipt,true)
 for(const bad of [{...value,command:'pulse'},{...value,posCashSale:'true'},{...value,expectedVersion:-1}])assert.throws(()=>p().validateDrawerPolicy(bad),e=>e.status===400)
})
