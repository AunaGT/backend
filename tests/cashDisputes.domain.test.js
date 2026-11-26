const test = require('node:test')
const assert = require('node:assert/strict')
const { calculateOriginCoverage, planRecovery, planBankRecovery, planDisposition, referenceKey, canonicalHash } = require('../src/modules/cash-closure/disputes.domain')

test('pending claims and unrecovered withdrawals share the refunded original coverage', () => {
  assert.deepEqual(calculateOriginCoverage({ amount:'100.00', refunded:'10.00', cases:[
    { claimed:'40.00', pending:true, withdrawn:'20.00', recovered:'0.00' },
    { claimed:'30.00', pending:false, withdrawn:'30.00', recovered:'10.00' },
  ] }), { claimable:'30.00', reserved:'40.00', withdrawn:'50.00', recovered:'10.00' })
  assert.throws(() => calculateOriginCoverage({amount:'100.00',refunded:'20.00',cases:[{claimed:'90.00',pending:true,withdrawn:'0.00',recovered:'0.00'}]}), {code:'DISPUTE_COVERAGE_CONFLICT'})
})

test('a recovered closed case releases coverage; invalid and excessive money is rejected', () => {
  assert.equal(calculateOriginCoverage({amount:'100.00',refunded:'0.00',cases:[{claimed:'100.00',pending:false,withdrawn:'100.00',recovered:'100.00'}]}).claimable,'100.00')
  for (const amount of ['-1','1e2','NaN','100.001',Infinity,100,'10000000000']) {
    assert.throws(() => calculateOriginCoverage({amount,refunded:'0',cases:[]}), {code:'DISPUTE_MONEY_INVALID'})
  }
  assert.throws(() => calculateOriginCoverage({amount:'100',refunded:'0',cases:[{claimed:'10',pending:false,withdrawn:'10',recovered:'11'}]}), {code:'DISPUTE_COVERAGE_CONFLICT'})
})

test('recovering a lost receipt retires only its free portion and never charges it twice', () => {
  assert.deepEqual(planDisposition({lost:'100',withdrawn:'100',recovered:'0',disposed:'0',free:'40',customerPrincipal:'100',absorbedPrincipal:'0',identifiedCustomer:true}),
    {retired:'40.00',charged:'60.00',absorbed:'0.00',total:'100.00'})
  assert.deepEqual(planDisposition({lost:'100',withdrawn:'100',recovered:'0',disposed:'0',free:'40',customerPrincipal:'0',absorbedPrincipal:'100',identifiedCustomer:false}),
    {retired:'0.00',charged:'0.00',absorbed:'100.00',total:'100.00'})
  assert.throws(() => planDisposition({lost:'100',withdrawn:'0',recovered:'0',disposed:'0',free:'40',customerPrincipal:'100',absorbedPrincipal:'0',identifiedCustomer:true}), {code:'DISPUTE_DISPOSITION_EXCEEDS'})
  assert.throws(() => planDisposition({lost:'100',withdrawn:'100',recovered:'0',disposed:'0',free:'40',customerPrincipal:'100',absorbedPrincipal:'0',identifiedCustomer:false}), {code:'DISPUTE_CUSTOMER_REQUIRED'})
})

test('provider recoveries prioritize customer lots proportionally with stable cent remainder', () => {
  const lots = [{id:'b',kind:'RECEIPT_RETIRED',remaining:'40'}, {id:'a',kind:'CUSTOMER_CHARGE',remaining:'60'}, {id:'c',kind:'ABSORBED',remaining:'20'}]
  assert.deepEqual(planRecovery(lots,'0.03'), [{lotId:'a',amount:'0.02'},{lotId:'b',amount:'0.01'}])
  assert.deepEqual(planRecovery([...lots].reverse(),'110'), [{lotId:'a',amount:'60.00'},{lotId:'b',amount:'40.00'},{lotId:'c',amount:'10.00'}])
  assert.throws(() => planRecovery(lots,'121'), {code:'DISPUTE_RECOVERY_EXCEEDS'})
})

test('forgiven principal is a business loss and is not allocated another customer credit', () => {
  assert.deepEqual(planRecovery([{id:'paid',kind:'CUSTOMER_CHARGE',remaining:'20'},{id:'forgiven',kind:'ABSORBED',remaining:'40'}],'60'),
    [{lotId:'paid',amount:'20.00'},{lotId:'forgiven',amount:'40.00'}])
})

test('a partial-win recovery clears the undisposed bank balance before reducing a lost customer charge', () => {
  const lots=[{id:'customer',kind:'CUSTOMER_CHARGE',remaining:'60'}]
  assert.deepEqual(planBankRecovery({withdrawn:'100',recovered:'0',lots,principal:'40'}),{undisposed:'40.00',lots:[]})
  assert.deepEqual(planBankRecovery({withdrawn:'100',recovered:'0',lots,principal:'50'}),{undisposed:'40.00',lots:[{lotId:'customer',amount:'10.00'}]})
  assert.deepEqual(planBankRecovery({withdrawn:'100',recovered:'40',lots,principal:'60'}),{undisposed:'0.00',lots:[{lotId:'customer',amount:'60.00'}]})
  assert.throws(()=>planBankRecovery({withdrawn:'100',recovered:'40',lots,principal:'61'}),{code:'DISPUTE_RECOVERY_EXCEEDS'})
  assert.throws(()=>planBankRecovery({withdrawn:'50',recovered:'0',lots,principal:'10'}),{code:'DISPUTE_COVERAGE_CONFLICT'})
})

test('an authorized merchant-funded refund preserves coverage without refunding bank principal twice', () => {
  const cases=[{claimed:'100',pending:false,withdrawn:'100',recovered:'0'}]
  assert.equal(calculateOriginCoverage({amount:'100',refunded:'40',fundedRefunds:'40',cases}).claimable,'0.00')
  assert.equal(calculateOriginCoverage({amount:'100',refunded:'40',fundedRefunds:'20',cases:[{...cases[0],recovered:'80'}]}).claimable,'60.00')
  assert.throws(()=>calculateOriginCoverage({amount:'100',refunded:'40',fundedRefunds:'41',cases:[]}),{code:'DISPUTE_COVERAGE_CONFLICT'})
})

test('attempt hashing canonicalizes object fields but preserves meaningful arrays and money strings', () => {
  assert.equal(canonicalHash({b:2,a:{d:4,c:3}}),canonicalHash({a:{c:3,d:4},b:2}))
  assert.notEqual(canonicalHash({applications:[{type:'SALE',id:'1'},{type:'DISPUTE_CHARGE',id:'2'}]}),canonicalHash({applications:[{type:'SALE',id:'1'}]}))
  assert.equal(referenceKey(' cb-1 '),'CB-1')
  assert.notEqual(referenceKey('CB-1'),referenceKey('CB1'))
})

test('a lost result not yet debited keeps occupying its principal until the bank withdraws or it is recovered', () => {
  const lost = { claimed:'100.00', pending:false, withdrawn:'0.00', recovered:'0.00', won:'0.00', lost:'100.00' }
  assert.equal(calculateOriginCoverage({ amount:'100.00', refunded:'0.00', cases:[lost] }).claimable, '0.00')
  assert.equal(calculateOriginCoverage({ amount:'100.00', refunded:'0.00', cases:[{ ...lost, withdrawn:'100.00' }] }).claimable, '0.00')
  assert.equal(calculateOriginCoverage({ amount:'100.00', refunded:'0.00', cases:[{ ...lost, withdrawn:'100.00', recovered:'100.00' }] }).claimable, '100.00', 'recovered money frees it again')
  assert.equal(calculateOriginCoverage({ amount:'100.00', refunded:'0.00', cases:[{ ...lost, won:'60.00', lost:'40.00' }] }).claimable, '60.00', 'only the lost part stays occupied')
})
