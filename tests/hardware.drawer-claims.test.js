const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto')
const {fixture}=require('./hardware.drawer-events.test')
const api=()=>require('../src/modules/config/hardware/drawer/intents')
async function ready(){const h=await fixture(),result=await require('../src/modules/config/hardware/drawer/events').enqueueDrawerIntent(h.db,h.scope,{origin:'POS_SALE',sourceId:h.sale.id});h.intentId=result.intentId;h.claim={intentId:h.intentId,workstationId:h.station.id,requestKey:randomUUID(),mode:'SIMULATED'};return h}
test('concurrent claims yield exactly one simulated lease and never return a second token',async()=>{
 const h=await ready(),results=await Promise.allSettled([api().claimIntent(h.db,h.scope,h.claim),api().claimIntent(h.db,h.scope,{...h.claim,requestKey:randomUUID()})])
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(h.rows('hardwareDrawerAttempt').length,1)
 const attempt=results.find(r=>r.status==='fulfilled').value
 assert.equal(attempt.expiresAt.toISOString(),'2026-10-17T18:00:05.000Z')
 assert.notEqual(h.rows('hardwareDrawerAttempt')[0].token_hash,attempt.claimToken)
 await assert.rejects(api().claimIntent(h.db,h.scope,h.claim),e=>e.status===409)
 const dto=await api().recordResult(h.db,h.scope,h.intentId,{attemptId:attempt.attemptId,claimToken:attempt.claimToken,outcome:'SIMULATED'})
 assert.equal(dto.state,'SIMULATED');assert.equal(dto.claimToken,undefined);assert.equal(h.rows('sale')[0].total,'10')
})
test('database clock expiry never goes back to pending; late results cannot confirm simulation',async()=>{
 const h=await ready(),attempt=await api().claimIntent(h.db,h.scope,h.claim);h.clock=new Date('2026-10-17T18:00:06Z')
 await assert.rejects(api().recordResult(h.db,h.scope,h.intentId,{attemptId:attempt.attemptId,claimToken:attempt.claimToken,outcome:'SIMULATED'}),e=>e.status===409)
 assert.equal(h.rows('hardwareDrawerIntent')[0].state,'EXPIRED')
 const second=await ready();second.clock=new Date('2026-10-17T18:00:31Z');await assert.rejects(api().claimIntent(second.db,second.scope,second.claim),e=>e.status===409);assert.equal(second.rows('hardwareDrawerAttempt').length,0)
})
test('physical mode, revoked permission, changed route, closed turn and foreign actor cannot claim',async()=>{
 for(const change of ['PHYSICAL','permission','route','session','actor']){
  const h=await ready();let scope=h.scope,input=h.claim
  if(change==='PHYSICAL')input={...input,mode:'PHYSICAL'}
  if(change==='permission')scope={...scope,permissions:['sales.create']}
  if(change==='actor')scope={...scope,actorId:randomUUID()}
  if(change==='route')await h.db.hardwareDevice.updateMany({where:{id:h.drawer.id},data:{version:2}})
  if(change==='session')await h.db.cashRegisterSession.updateMany({where:{id:h.session.id},data:{status:'CLOSED'}})
  await assert.rejects(api().claimIntent(h.db,scope,input),e=>[400,403,404,409].includes(e.status));assert.equal(h.rows('hardwareDrawerAttempt').length,0)
 }
})
test('slow route queries cannot claim or confirm after the database deadline',async()=>{
 for(const action of ['claim','result']){
  const h=await ready(),attempt=action==='result'?await api().claimIntent(h.db,h.scope,h.claim):null
  const find=h.db.hardwareDevice.findFirst
  h.db.hardwareDevice.findFirst=async input=>{h.clock=new Date(action==='result'?'2026-10-17T18:00:06Z':'2026-10-17T18:00:31Z');return find(input)}
  await assert.rejects(action==='claim'?api().claimIntent(h.db,h.scope,h.claim):api().recordResult(h.db,h.scope,h.intentId,{attemptId:attempt.attemptId,claimToken:attempt.claimToken,outcome:'SIMULATED'}),e=>e.status===409)
  assert.equal(h.rows('hardwareDrawerIntent')[0].state,'EXPIRED')
 }
})
