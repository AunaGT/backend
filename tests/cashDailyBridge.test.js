const test=require('node:test'),assert=require('node:assert/strict')
const day='2026-11-19'
const turn=(id,opening,inherited=null)=>({id,cash_register_id:id[0],register_type:'PHYSICAL',opening_float:opening,opening_inherited_amount:inherited})
const event=(session,amount,direction='IN',source_type='CUSTOMER_PAYMENT')=>({cash_register_session_id:session,amount,direction,source_type,settlement_kind:'CASH'})
test('cash bridge traces mixed inheritance and two boxes without counting funds twice',()=>{
  const {cashBridge}=require('../src/modules/cash-closure/dailyCashBridge')
  const turns=[turn('A1','100'),turn('A2','75','75'),turn('B1','40','40')]
  const entries=[
    {id:'p',cash_register_id:'B',holder_kind:'FLOAT',leg:'RETAIN',direction:'IN',amount:'40',origin_session_id:'B0',origin_business_date:'2026-11-18'},
    {id:'ob',cash_register_id:'B',holder_kind:'FLOAT',leg:'OPENING',direction:'OUT',amount:'40',opening_session_id:'B1'},
    {id:'r',cash_register_id:'A',holder_kind:'FLOAT',leg:'RETAIN',direction:'IN',amount:'60',origin_session_id:'A1',origin_business_date:day},
    {id:'c',cash_register_id:'A',holder_kind:'FLOAT',leg:'RECEIVE',direction:'IN',amount:'15',transfer_id:'custody15'},
    {id:'oa',cash_register_id:'A',holder_kind:'FLOAT',leg:'OPENING',direction:'OUT',amount:'75',opening_session_id:'A2'},
  ]
  const events=[event('A1','50'),event('A1','10','OUT','PHYSICAL_MOVEMENT'),event('A1','20','OUT','CUSTODY_ENTRY'),event('A2','30'),event('B1','20','IN','CUSTODY_ENTRY'),event('B1','25')]
  const handovers=[{cash_register_session_id:'A1',delivered_amount:'60',retained_amount:'60'},{cash_register_session_id:'A2',delivered_amount:'105',retained_amount:'0'}]
  const result=cashBridge({date:day,turns,events,handovers,floatEntries:entries})
  assert.equal(result.initial,'140.00');assert.equal(result.inheritedInitial,'40.00');assert.equal(result.declaredInitial,'100.00')
  assert.equal(result.internal.inheritedWithinDay,'60.00');assert.equal(result.internal.openingTransfersIn,'15.00')
  assert.equal(result.internal.sessionsIn,'20.00');assert.equal(result.internal.sessionsOut,'20.00')
  assert.equal(result.internal.delivered,'165.00');assert.equal(result.externalIn,'105.00');assert.equal(result.externalOut,'10.00')
  assert.equal(result.final,'85.00');assert.equal(result.retainedFinal,'0.00');assert.equal(result.undeliveredFinal,'85.00');assert.equal(result.difference,'0.00');assert.equal(result.balanced,true)
  const short=cashBridge({date:day,turns,events,handovers:[handovers[0],{...handovers[1],delivered_amount:'104'}],floatEntries:entries,acceptedDifference:'-1.00'})
  assert.equal(short.final,'85.00');assert.equal(short.balanced,true)
})
test('a float counted differently at opening is a visible opening discrepancy, not external revenue',()=>{
  const {cashBridge}=require('../src/modules/cash-closure/dailyCashBridge')
  const result=cashBridge({date:day,turns:[turn('A1','99','100')],events:[],handovers:[],floatEntries:[{id:'r',cash_register_id:'A',leg:'RETAIN',direction:'IN',amount:'100',origin_business_date:'2026-11-18',origin_session_id:'old'},{id:'o',cash_register_id:'A',leg:'OPENING',direction:'OUT',amount:'100',opening_session_id:'A1'}]})
  assert.equal(result.initial,'100.00');assert.equal(result.openingDifference,'-1.00');assert.equal(result.final,'99.00');assert.equal(result.balanced,true)
})
test('missing inherited provenance is blocked instead of manufacturing a balanced opening',()=>{
  const {cashBridge}=require('../src/modules/cash-closure/dailyCashBridge')
  assert.throws(()=>cashBridge({date:day,turns:[turn('A1','40','40')],events:[],handovers:[],floatEntries:[]}),e=>e.code==='CASH_DAY_PROVENANCE')
})
test('retained cash transferred to another box, custody or returned stays one amount',()=>{
  const {cashBridge}=require('../src/modules/cash-closure/dailyCashBridge')
  const retained={id:'r',cash_register_id:'A',leg:'RETAIN',direction:'IN',amount:'100',origin_session_id:'A1',origin_business_date:day}
  const send={id:'s',cash_register_id:'A',leg:'SEND',direction:'OUT',amount:'100',transfer_id:'move'}
  const receive={id:'recv',cash_register_id:'B',leg:'RECEIVE',direction:'IN',amount:'100',transfer_id:'move',origin_kind:'FLOAT'}
  const base={date:day,turns:[turn('A1','100')],events:[],handovers:[{cash_register_session_id:'A1',retained_amount:'100',delivered_amount:'0'}]}
  const moved=cashBridge({...base,turns:[...base.turns,turn('B1','100','100')],floatEntries:[retained,send,receive,{id:'o',cash_register_id:'B',leg:'OPENING',direction:'OUT',amount:'100',opening_session_id:'B1'}]})
  assert.equal(moved.final,'100.00');assert.equal(moved.retainedFinal,'0.00');assert.equal(moved.internal.net,'0.00');assert.equal(moved.balanced,true)
  const transit=cashBridge({...base,floatEntries:[retained,send]});assert.equal(transit.final,'0.00');assert.equal(transit.internal.net,'-100.00');assert.equal(transit.balanced,true)
  const resting=cashBridge({...base,floatEntries:[retained,send,receive]});assert.equal(resting.final,'100.00');assert.equal(resting.internal.net,'0.00')
  const returned=cashBridge({...base,floatEntries:[retained,send,{...receive,cash_register_id:'A',transfer_id:'return',origin_kind:'RETURN',returns_transfer_id:'move'}]})
  assert.equal(returned.final,'100.00');assert.equal(returned.retainedFinal,'100.00');assert.equal(returned.internal.net,'0.00');assert.equal(returned.balanced,true)
})
