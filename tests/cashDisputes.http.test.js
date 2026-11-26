const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto')
const {withMocks,jsonResponse}=require('./helpers/reportHarness.cjs')
const file=require.resolve('../src/modules/cash-closure/disputes.controller')
function req(perms=['cash.disputes.view']){return {companyId:randomUUID(),branchId:randomUUID(),user:{sub:randomUUID(),permissions:perms,role:{name:'operador',company_id:randomUUID()}},params:{},query:{}}}
test('dispute capabilities advertise read access but keep incomplete financial commands closed',async()=>{
  await withMocks({[require.resolve('../src/models/prisma')]:{prisma:{}},[require.resolve('../src/modules/cash-closure/disputes.queries')]:{disputesAvailable:async()=>true}},file,async controller=>{
    const res=jsonResponse();res.set=()=>res
    await controller.capabilities(req(),res,e=>{throw e})
    assert.equal(res.body.available,true);assert.equal(res.body.commandsAvailable,false);assert.equal(res.body.can.read,true)
  })
})
test('no financial command runs before all dependent writers are integrated',async()=>{
  await withMocks({[require.resolve('../src/models/prisma')]:{prisma:{$transaction:()=>assert.fail('Unavailable command must not start a financial transaction')}},[require.resolve('../src/modules/cash-closure/disputes.queries')]:{disputesAvailable:async()=>true}},file,async controller=>{
    const res=jsonResponse();res.set=()=>res
    let error;await controller.create(req(['cash.disputes.manage']),res,e=>{error=e})
    assert.equal(error.status,409);assert.equal(error.code,'DISPUTE_COMMANDS_UNAVAILABLE')
    error=null;await controller.confirmEffect(req(['cash.disputes.movements']),res,e=>{error=e})
    assert.equal(error.status,409);assert.equal(error.code,'DISPUTE_COMMANDS_UNAVAILABLE')
  })
})
function released(extra={}){
  const calls=[],tx={tx:true}
  return {calls,mocks:{[require.resolve('../src/models/prisma')]:{prisma:{$transaction:async fn=>fn(tx)}},
    [require.resolve('../src/modules/cash-closure/disputes.release')]:{commandsReleased:()=>true},
    [require.resolve('../src/modules/cash-closure/disputes.queries')]:{disputesAvailable:async()=>true},
    [require.resolve('../src/modules/cash-closure/disputes')]:{createDispute:async(t,s,b)=>{calls.push(['create',t===tx,s.can.manage,b]);return{id:'case'}},decideDisputeProposal:async(t,s,c,p)=>{calls.push(['decide',c,p]);return{id:c}}},
    [require.resolve('../src/services/accounting/cashDisputePosting')]:{postDisputeChain:async(t,s,c,o)=>{calls.push(['post',c,o]);return{status:'POSTED'}},inspectDisputeAccounting:async()=>({})},
    [require.resolve('../src/modules/cash-closure/disputes.evidence')]:{signDisputeEvidence:async(db,s,c,e)=>{calls.push(['sign',c,e]);return{url:'u'}},evidenceAvailable:async()=>true},...extra}}
}
test('released commands run their real service in one transaction and keep each action permission',async()=>{
  const {calls,mocks}=released()
  await withMocks(mocks,file,async controller=>{
    const ok=async(handler,r)=>{const res=jsonResponse();res.set=()=>res;let error;await handler(r,res,e=>{error=e});if(error)throw error;return res.body}
    const created=await ok(controller.create,{...req(['cash.disputes.manage']),body:{claimed:'10'}})
    assert.deepEqual(created,{id:'case'});assert.deepEqual(calls[0],['create',true,true,{claimed:'10'}])
    await assert.rejects(ok(controller.create,{...req(['cash.disputes.view']),body:{}}),{status:403})
    await ok(controller.decide,{...req(['cash.disputes.resolve']),params:{caseId:'c1',proposalId:'p1'},body:{}})
    assert.deepEqual(calls.at(-1),['decide','c1','p1'])
    await assert.rejects(ok(controller.post,{...req(['cash.disputes.resolve']),params:{caseId:'c1'},body:{}}),{status:403},'resolving disputes is not accounting authority')
    await ok(controller.post,{...req(['cash.disputes.view','accounting.create']),params:{caseId:'c1'},body:{accountingDateBySource:{e1:{accountingDate:'2026-11-25'}}}})
    assert.deepEqual(calls.at(-1),['post','c1',{accountingDateBySource:{e1:{accountingDate:'2026-11-25'}}}])
    const caps=await ok(controller.capabilities,req(['cash.disputes.movements']))
    assert.equal(caps.commandsAvailable,true);assert.equal(caps.can.movements,true);assert.equal(caps.evidenceUpload,true)
  })
})
test('opening private evidence is a read that works while commands stay closed',async()=>{
  const {calls,mocks}=released({[require.resolve('../src/modules/cash-closure/disputes.release')]:{commandsReleased:()=>false}})
  await withMocks(mocks,file,async controller=>{
    const res=jsonResponse();res.set=()=>res
    await controller.evidence({...req(),params:{caseId:'c1',evidenceId:'e1'}},res,e=>{throw e})
    assert.deepEqual(res.body,{url:'u'});assert.deepEqual(calls,[['sign','c1','e1']])
    let error;await controller.attachEvidence({...req(['cash.disputes.manage']),params:{caseId:'c1'},body:{}},res,e=>{error=e})
    assert.equal(error.code,'DISPUTE_COMMANDS_UNAVAILABLE')
  })
})

test('a dispute guard raised by the database reaches the user as a 409 without SQL text',()=>{
  const {errorHandler}=require('../src/middlewares/errorHandler'),original=console.error;console.error=()=>{}
  try{
    const res={statusCode:200,body:null,headersSent:false,status(c){this.statusCode=c;return this},json(b){this.body=b;return this}}
    errorHandler(new Error('Invalid `prisma.$executeRaw()` invocation: Raw query failed. Code: `P0001`. Message: `ERROR: dispute_coverage`'),{},res,()=>{})
    assert.equal(res.statusCode,409);assert.equal(res.body.code,'DISPUTE_STATE_CHANGED');assert.doesNotMatch(res.body.message,/prisma|ERROR|dispute_coverage/)
    const other={...res,statusCode:200};errorHandler(new Error('boom'),{},other,()=>{});assert.equal(other.statusCode,500)
  }finally{console.error=original}
})
