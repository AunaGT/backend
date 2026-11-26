const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto')
const {qaSchema,fixture}=require('./helpers/cashCorrectionsQa.cjs'),flow=require('../src/modules/cash-closure/corrections')
const url=process.env.AUNA_CASH_DAILY_QA_URL
const input=(ctx,actual='980.00')=>({reason:'Error de digitación confirmado',accountingDate:'2026-11-20',previousCorrectionId:ctx.previousCorrectionId,lines:ctx.lines.map(l=>({closurePaymentId:l.closurePaymentId,correctedActual:actual})),requestKey:randomUUID()})
async function proposal(db,f,scope=f.scope,actual) {
  const ctx=await flow.correctionContext(db,scope,f.id),b=input(ctx,actual)
  b.previewKey=(await flow.previewCorrection(db,scope,f.id,b)).previewKey
  return {b,doc:await db.$transaction(tx=>flow.proposeCorrection(tx,scope,f.id,b))}
}
test('additive migration preserves original tables; missing schema blocks capabilities', {skip:!url,timeout:120000},async()=>{
  const qa=await qaSchema(url,{migrate:false}),{db}=qa
  try {
    const f=await fixture(db),before=await db.$queryRaw`SELECT to_jsonb(c) AS row FROM cash_closures c WHERE id=${f.id}::uuid`
    const tables=await db.$queryRaw`SELECT tablename FROM pg_tables WHERE schemaname=current_schema() ORDER BY tablename`
    const projection=()=>Promise.all(tables.map(({tablename})=>db.$queryRawUnsafe(`SELECT count(*)::int AS count,md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' ORDER BY md5(to_jsonb(t)::text)),'')) AS hash FROM "${tablename.replaceAll('"','""')}" t`)))
    const allBefore=await projection()
    assert.equal((await flow.correctionContext(db,f.scope,f.id)).available,false)
    qa.apply();assert.deepEqual(await db.$queryRaw`SELECT to_jsonb(c) AS row FROM cash_closures c WHERE id=${f.id}::uuid`,before)
    assert.deepEqual(await projection(),allBefore,'all preexisting tables preserve their contents')
    assert.equal((await flow.correctionContext(db,f.scope,f.id)).eligible,true)
  }finally{await db.$disconnect()}
})
test('operational corrections preserve history, enforce independent review and replay receipts', {skip:!url,timeout:120000},async()=>{
  const {db}=await qaSchema(url)
  try {
    const f=await fixture(db),before=await db.$queryRaw`SELECT to_jsonb(c) AS row FROM cash_closures c WHERE id=${f.id}::uuid`
    const {b,doc}=await proposal(db,f)
    assert.equal(doc.status,'PENDING');assert.equal(doc.lines[0].delta,'80.00')
    const consolidated=await flow.getCorrection(db,{...f.scope,branchId:null,canPropose:false,canReview:false},f.id,doc.id)
    assert.equal(consolidated.status,'PENDING');assert.deepEqual(consolidated.can,{approve:false,reject:false,cancel:false})
    assert.deepEqual(await db.$transaction(tx=>flow.proposeCorrection(tx,f.scope,f.id,b)),doc)
    const decide={action:'APPROVE',expectedUpdatedAt:doc.updatedAt,requestKey:randomUUID(),reason:'Verificado'}
    await assert.rejects(db.$transaction(tx=>flow.decideCorrection(tx,f.scope,f.id,doc.id,decide)),e=>e.status===403)
    const approved=await db.$transaction(tx=>flow.decideCorrection(tx,f.reviewer,f.id,doc.id,decide))
    assert.equal(approved.status,'APPROVED');assert.equal(approved.accountingStatus,'DEFERRED')
    assert.deepEqual(await db.$transaction(tx=>flow.decideCorrection(tx,f.reviewer,f.id,doc.id,decide)),approved)
    const next=await proposal(db,f,f.scope,'970.00');assert.equal(next.doc.lines[0].delta,'-10.00')
    const last=await db.$transaction(tx=>flow.decideCorrection(tx,f.reviewer,f.id,next.doc.id,{...decide,requestKey:randomUUID(),expectedUpdatedAt:next.doc.updatedAt}))
    assert.equal(last.sequence,2);assert.equal(last.lines[0].correctedDifference,'-30.00')
    assert.deepEqual(await db.$queryRaw`SELECT to_jsonb(c) AS row FROM cash_closures c WHERE id=${f.id}::uuid`,before)
    await assert.rejects(db.$executeRaw`UPDATE cash_closure_corrections SET reason='changed' WHERE id=${doc.id}::uuid`,/immutable/)
    await assert.rejects(db.$executeRaw`DELETE FROM cash_closure_correction_lines WHERE correction_id=${doc.id}::uuid`,/immutable/)
    await assert.rejects(db.$executeRaw`UPDATE cash_closure_correction_commands SET result='{}' WHERE correction_id=${doc.id}::uuid`,/immutable/)
  }finally{await db.$disconnect()}
})
test('parallel proposals cannot both approve the same base; foreign parent reads do not leak', {skip:!url,timeout:120000},async()=>{
  const {db}=await qaSchema(url)
  try {
    const f=await fixture(db),a=await proposal(db,f),b=await proposal(db,f,f.scope,'990.00')
    const results=await Promise.allSettled([a,b].map(({doc})=>db.$transaction(tx=>flow.decideCorrection(tx,f.reviewer,f.id,doc.id,{action:'APPROVE',expectedUpdatedAt:doc.updatedAt,requestKey:randomUUID()}))))
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1)
    assert.equal(results.find(r=>r.status==='rejected').reason.status,409)
    const other=await fixture(db)
    await assert.rejects(flow.getCorrection(db,other.scope,other.id,a.doc.id),e=>e.status===404)
    await assert.rejects(flow.correctionContext(db,{...f.scope,viewTeam:false,mode:'mine',userId:other.user.id},f.id),e=>e.status===404)
  }finally{await db.$disconnect()}
})
test('SQL rejects incomplete documents, forged lines and public access; finalized daily history stays frozen',{skip:!url,timeout:120000},async()=>{
  const qa=await qaSchema(url),{db}=qa
  try{
    const f=await fixture(db),ctx=await flow.correctionContext(db,f.scope,f.id),other=await fixture(db)
    const header=(tx,changes={})=>tx.$queryRaw`INSERT INTO cash_closure_corrections(id,company_id,branch_id,closure_id,currency_code,reason,accounting_date,proposed_by_id,base_key,content_hash)
      VALUES(${changes.id||randomUUID()}::uuid,${changes.companyId||f.company.id}::uuid,${f.branch.id}::uuid,${f.id}::uuid,${changes.currency||'GTQ'},'QA','2026-11-20',${f.user.id}::uuid,${ctx.baseKey},${'a'.repeat(64)}) RETURNING id`
    await assert.rejects(db.$transaction(tx=>header(tx)),/incomplete/)
    await assert.rejects(db.$transaction(tx=>header(tx,{currency:'USD'})),/scope_or_snapshot/)
    await assert.rejects(db.$transaction(tx=>header(tx,{companyId:other.company.id})),/scope_or_snapshot/)
    await assert.rejects(db.$transaction(async tx=>{
      const [h]=await header(tx)
      await tx.$executeRaw`INSERT INTO cash_closure_correction_lines(correction_id,closure_payment_id,payment_method_id,payment_method_name,settlement_kind,original_expected,previous_actual,corrected_actual,delta,corrected_difference)
        VALUES(${h.id}::uuid,${f.paymentId},${f.method.id},${f.method.name},'CASH',1,900,980,80,979)`
    }),/line_scope/)
    const snapshot={version:2,businessDate:'2026-01-02',turns:[{id:f.session.id,closure_id:f.id}],cash:{historical:'900.00'}}
    await db.$executeRaw`INSERT INTO cash_daily_consolidations(company_id,branch_id,business_date,content_hash,snapshot,finalized_by_id) VALUES(${f.company.id}::uuid,${f.branch.id}::uuid,'2026-01-02',${'b'.repeat(64)},${JSON.stringify(snapshot)}::jsonb,${f.user.id}::uuid)`
    const daily=await db.$queryRaw`SELECT to_jsonb(d) AS row FROM cash_daily_consolidations d`
    const moneyBefore=await db.$queryRaw`SELECT count(*)::int AS n FROM cash_money_events`
    const {doc}=await proposal(db,f)
    await db.$transaction(tx=>flow.decideCorrection(tx,f.reviewer,f.id,doc.id,{action:'APPROVE',requestKey:randomUUID(),expectedUpdatedAt:doc.updatedAt}))
    assert.deepEqual(await db.$queryRaw`SELECT to_jsonb(d) AS row FROM cash_daily_consolidations d`,daily)
    assert.deepEqual(await db.$queryRaw`SELECT count(*)::int AS n FROM cash_money_events`,moneyBefore)
    const day=await require('../src/modules/cash-closure/dailyConsolidation').dayView(db,f.scope,'2026-01-02')
    assert.deepEqual(day.snapshot,snapshot);assert.equal(day.current.corrections[0].cash_delta,'80.00')
    const [acl]=await db.$queryRaw`SELECT relrowsecurity,coalesce(array_to_string(relacl,','),'') AS acl FROM pg_class WHERE oid='cash_closure_corrections'::regclass`
    assert.equal(acl.relrowsecurity,true);assert.equal(acl.acl.includes('=r/'),false)
  }finally{await db.$disconnect()}
})
test('owner self-review requires an explicit policy and reason; terminal rejections and cancellations cannot be edited',{skip:!url,timeout:120000},async()=>{
  const {db}=await qaSchema(url)
  try{
    const f=await fixture(db),{doc}=await proposal(db,f)
    await db.$executeRaw`INSERT INTO cash_difference_policies(company_id,owner_self_review,updated_by_id) VALUES(${f.company.id}::uuid,true,${f.user.id}::uuid)`
    const b={action:'APPROVE',requestKey:randomUUID(),expectedUpdatedAt:doc.updatedAt}
    await assert.rejects(db.$transaction(tx=>flow.decideCorrection(tx,f.scope,f.id,doc.id,b)),e=>e.status===400)
    const a=await db.$transaction(tx=>flow.decideCorrection(tx,f.scope,f.id,doc.id,{...b,reason:'Dueño verifica la evidencia'}))
    assert.equal(a.selfReview,true)
    const next=await proposal(db,f,f.scope,'970')
    const rejected=await db.$transaction(tx=>flow.decideCorrection(tx,f.reviewer,f.id,next.doc.id,{action:'REJECT',reason:'Sin evidencia',requestKey:randomUUID(),expectedUpdatedAt:next.doc.updatedAt}))
    assert.equal(rejected.status,'REJECTED')
    await assert.rejects(db.$transaction(tx=>flow.cancelCorrection(tx,f.scope,f.id,next.doc.id,{reason:'Otro intento',requestKey:randomUUID(),expectedUpdatedAt:rejected.updatedAt})),e=>e.status===403)
  }finally{await db.$disconnect()}
})
test('historical shared participants cannot approve and ambiguous legacy remains read-only',{skip:!url,timeout:120000},async()=>{
  const {db}=await qaSchema(url)
  try{
    const f=await fixture(db),turn=await f.open()
    await db.$transaction(tx=>require('../src/services/cashSharedSessions').join(tx,f.otherScope,turn.id))
    await db.$executeRaw`UPDATE cash_register_sessions SET status='CLOSED',closed_at=now(),cash_closure_id=${f.id}::uuid WHERE id=${turn.id}::uuid`
    await db.$executeRaw`UPDATE cash_register_access SET active=false WHERE register_id=${f.register2.id}::uuid AND user_id=${f.other.id}::uuid`
    const {doc}=await proposal(db,f)
    await assert.rejects(db.$transaction(tx=>flow.decideCorrection(tx,f.reviewer,f.id,doc.id,{action:'APPROVE',requestKey:randomUUID(),expectedUpdatedAt:doc.updatedAt})),e=>e.status===403)
    const old=await fixture(db,{frozen:false}),ctx=await flow.correctionContext(db,old.scope,old.id)
    assert.equal(ctx.eligible,false);assert.match(ctx.issue,/histórico/)
    await assert.rejects(flow.previewCorrection(db,old.scope,old.id,input(ctx)),e=>e.status===409)
  }finally{await db.$disconnect()}
})
test('real HTTP routes scope reads and writes, keep responses private and reject auxiliary ID leaks',{skip:!url,timeout:120000},async()=>{
  const {db}=await qaSchema(url),express=require('express'),{withMocks}=require('./helpers/reportHarness.cjs')
  let server
  try{
    const f=await fixture(db),other=await fixture(db)
    await withMocks({[require.resolve('../src/models/prisma')]:{prisma:db},[require.resolve('../src/middlewares/autenticacion')]:{Auth:(req,res,next)=>next(),hasPermission:()=>((req,res,next)=>next())}},require.resolve('../src/modules/cash-closure/routes'),async router=>{
      const app=express();app.use(express.json());app.use((req,res,next)=>{const cross=req.headers['x-qa-cross']==='yes';req.companyId=cross?other.company.id:f.company.id;req.branchId=req.headers['x-qa-all']==='yes'?'all':cross?other.branch.id:f.branch.id;req.user={sub:f.user.id,permissions:[req.headers['x-qa-reader']==='yes'?'cashclosure.view':'cashclosure.correct']};if(req.headers['x-qa-integration'])req.integrationCredential={};next()});app.use('/cash-closures',router);app.use((e,req,res,next)=>res.status(e.status||500).json({message:e.message}))
      server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s))})
      const base=`http://127.0.0.1:${server.address().port}/cash-closures/${f.id}/corrections`
      let response=await fetch(base+'/context');assert.equal(response.status,200);assert.match(response.headers.get('cache-control'),/no-store/);const ctx=await response.json()
      const b=input(ctx);response=await fetch(base+'/preview',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});assert.equal(response.status,200);b.previewKey=(await response.json()).previewKey
      response=await fetch(base,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});assert.equal(response.status,200);const doc=await response.json()
      for(const [path,headers,status]of [['/context',{'x-qa-cross':'yes'},404],['/context',{'x-qa-all':'yes'},403],['/context',{'x-qa-integration':'yes'},401],['/'+randomUUID(),{},404]]){response=await fetch(base+path,{headers});assert.equal(response.status,status)}
      response=await fetch(base+'/'+doc.id+'/decide',{method:'POST',headers:{'Content-Type':'application/json','x-qa-reader':'yes'},body:JSON.stringify({action:'APPROVE',expectedUpdatedAt:doc.updatedAt,requestKey:randomUUID()})});assert.equal(response.status,403)
    })
  }finally{if(server)await new Promise(resolve=>server.close(resolve));await db.$disconnect()}
})
test('a corrected cash declaration shows a handover discrepancy without changing custody or its documents',{skip:!url,timeout:120000},async()=>{
  const {db}=await qaSchema(url)
  try{
    const f=await fixture(db)
    await db.$executeRaw`UPDATE cash_register_sessions SET status='CLOSED',closed_at=now(),cash_closure_id=${f.id}::uuid WHERE id=${f.session.id}::uuid`
    await db.$transaction(tx=>require('../src/modules/cash-closure/custody').handoverTurn(tx,{...f.scope,canOperateOwn:true},f.session.id,{requestKey:randomUUID(),deliveredAmount:'0',retainedAmount:'900'}))
    const before=await db.$queryRaw`SELECT to_jsonb(h) AS row FROM cash_turn_handovers h UNION ALL SELECT to_jsonb(e) FROM cash_custody_entries e`
    const {doc}=await proposal(db,f)
    assert.equal(doc.custodyComparison.recorded,'900.00');assert.equal(doc.custodyComparison.difference,'80.00')
    await db.$transaction(tx=>flow.decideCorrection(tx,f.reviewer,f.id,doc.id,{action:'APPROVE',requestKey:randomUUID(),expectedUpdatedAt:doc.updatedAt}))
    assert.deepEqual(await db.$queryRaw`SELECT to_jsonb(h) AS row FROM cash_turn_handovers h UNION ALL SELECT to_jsonb(e) FROM cash_custody_entries e`,before)
  }finally{await db.$disconnect()}
})
