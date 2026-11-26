const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto')
const {qaSchema,fixture}=require('./helpers/cashSharedQa.cjs'),{closure:makeClosure,review}=require('./helpers/cashReviewQa.cjs')
const closure=(db,f,options={})=>makeClosure(db,f,{...options,snapshot:{basis:'EVENTS_V1',payment_breakdowns:[],theoretical:{},cash_session:null}})
const url=process.env.AUNA_CASH_DAILY_QA_URL
test('own closure reads include shared recount history but never another actor or tenant, including aggregates', {skip:!url,timeout:120000},async()=>{
 const {db}=await qaSchema(url)
 try {
  const f=await fixture(db),turn=await f.open(),shared=require('../src/services/cashSharedSessions')
  await db.$transaction(tx=>shared.join(tx,f.otherScope,turn.id))
  const stranger=await db.user.create({data:{name:'QA observer',email:`observer-${randomUUID()}@qa.invalid`,password:'unused',role_id:f.user.role_id}})
  const declared={...f,user:stranger},old=await closure(db,declared)
  await db.$executeRaw`UPDATE cash_register_sessions SET status='CLOSED',closed_at=now(),cash_closure_id=${old}::uuid WHERE id=${turn.id}::uuid`
  const replace=async previous=>{
    await review(db,f,previous,'RECOUNT_REQUESTED')
    await db.$executeRaw`UPDATE cash_closures SET status='Reconteo' WHERE id=${previous}::uuid`
    return db.$transaction(async tx=>{
      const next=await closure(tx,declared,{supersedes:previous})
      await tx.$executeRaw`UPDATE cash_register_sessions SET cash_closure_id=${next}::uuid WHERE id=${turn.id}::uuid`
      await tx.$executeRaw`UPDATE cash_closures SET status='Sustituido' WHERE id=${previous}::uuid`
      return next
    })
  }
  const middle=await replace(old),latest=await replace(middle)
  const unrelated=await closure(db,declared),legacy=await closure(db,{...f,user:{id:null}},{version:0})
  const q=require('../src/modules/cash-closure/readQueries')
  const scope={companyId:f.company.id,branchIds:[f.branch.id],userId:f.other.id,mode:'mine',viewOwn:true,viewTeam:false}
  const own=await q.readPage(db,scope,{page:1,pageSize:2,includeSummary:true})
  assert.equal(own.totalItems,3);assert.equal(own.totalPages,2);assert.equal(own.ids.length,2);assert.equal(own.summary.total,3)
  const today=require('luxon').DateTime.now().setZone('America/Guatemala').toISODate()
  assert.equal((await q.readPage(db,scope,{startDate:today,endDate:today})).totalItems,3,'date-only filters include the whole local day')
  const second=await q.readPage(db,scope,{page:2,pageSize:2})
  assert.deepEqual(new Set([...own.ids,...second.ids]),new Set([old,middle,latest]))
  for(const id of [old,middle,latest])await q.assertReadable(db,scope,id)
  for(const id of [unrelated,legacy,randomUUID()])await assert.rejects(q.assertReadable(db,scope,id),e=>e.status===404)
  assert.equal((await q.readPage(db,{...scope,mode:'team',viewTeam:true},{page:1,pageSize:20})).totalItems,5)
  assert.equal((await q.readPage(db,{...scope,companyId:randomUUID()},{page:1,pageSize:20})).totalItems,0)
  assert.equal((await q.readPage(db,{...scope,branchIds:[randomUUID()]},{page:1,pageSize:20})).totalItems,0)
  assert.equal(await q.canReadSession(db,scope,turn.id),true)
  assert.equal(await q.canReadSession(db,{...scope,userId:stranger.id},turn.id),false)
  const {withMocks,jsonResponse}=require('./helpers/reportHarness.cjs')
  const request={companyId:f.company.id,branchId:f.branch.id,user:{sub:f.other.id,permissions:['cashclosure.view'],role:{name:'Cajero'}},query:{page:'1',pageSize:'2',includeSummary:'true'},params:{id:old}}
  await withMocks({[require.resolve('../src/models/prisma')]:{prisma:db}},require.resolve('../src/modules/cash-closure/controller'),async api=>{
    const invoke=async(action,req)=>{const res=jsonResponse();res.set=()=>res;let error;await api[action](req,res,e=>error=e);if(error)throw error;return res.body}
    const listed=await invoke('list',request);assert.equal(listed.summary.total,3);assert.equal(listed.items.length,2);assert.ok(listed.items.every(c=>[old,middle,latest].includes(c.id)))
    assert.equal((await invoke('getById',request)).id,old)
    await assert.rejects(invoke('getById',{...request,params:{id:unrelated}}),e=>e.status===404)
    const capabilities=require('../src/modules/cash-closure/reviewFlow.access').reviewScope({...request,user:{...request.user,permissions:['cashclosure.view_team']}},'capabilities')
    const reviewed=await require('../src/modules/cash-closure/reviewFlow').reviewContext(db,capabilities,latest)
    assert.equal(reviewed.history.length,2);assert.deepEqual(reviewed.can,{finalize:false,recount:false})
    assert.equal((await require('../src/modules/cash-closure/reviewFlow').sessionState(db,{...capabilities,viewTeam:false},turn.id)).closureId,latest)
  })
  await db.$executeRaw`UPDATE cash_register_access SET active=false WHERE register_id=${turn.cash_register_id}::uuid AND user_id=${f.other.id}::uuid`
  assert.equal((await q.readPage(db,scope,{page:1,pageSize:20})).totalItems,3)
  const owner=await q.readPage(db,{...scope,userId:f.user.id},{page:1,pageSize:20})
  assert.deepEqual(new Set(owner.ids),new Set([old,middle,latest]))
  for(const input of [{page:0},{pageSize:0},{pageSize:101},{page:'1.5'},{startDate:'bad'},{startDate:'2026-11-20',endDate:'2026-11-01'}])await assert.rejects(q.readPage(db,scope,input),e=>e.status===400)
 }finally{await db.$disconnect()}
})
