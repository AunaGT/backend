const test=require('node:test'),assert=require('node:assert/strict')
const {qaSchema,fixture,insertCase,tables}=require('./helpers/cashDisputesQa.cjs')
const url=process.env.AUNA_CASH_DISPUTES_QA_URL
test('additive dispute DDL preserves existing data and isolates all new tables',{skip:!url,timeout:240000},async()=>{
  const qa=await qaSchema(url,{migrate:false}),{db}=qa
  try {
    const f=await fixture(db)
    const existing=await db.$queryRaw`SELECT tablename FROM pg_tables WHERE schemaname=current_schema() ORDER BY tablename`
    const projection=()=>Promise.all(existing.map(({tablename})=>db.$queryRawUnsafe(`SELECT count(*)::int AS n,md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' ORDER BY md5(to_jsonb(t)::text)),'')) AS hash FROM "${tablename.replaceAll('"','""')}" t`)))
    const before=await projection();qa.apply();assert.deepEqual(await projection(),before)
    const acl=await db.$queryRaw`SELECT relname,relrowsecurity,coalesce(array_to_string(relacl,','),'') AS acl FROM pg_class WHERE relnamespace=current_schema()::regnamespace AND relname=ANY(${tables}::text[])`
    assert.equal(acl.length,tables.length)
    for(const row of acl){assert.equal(row.relrowsecurity,true);assert.equal(row.acl.includes('=r/'),false)}
    const [{publicFunctions}]=await db.$queryRaw`SELECT count(*)::int AS "publicFunctions" FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      WHERE p.pronamespace=current_schema()::regnamespace AND (p.proname LIKE 'cash_dispute_%' OR p.proname LIKE 'protect_cash_dispute%' OR p.proname LIKE 'check_cash_dispute%' OR p.proname LIKE 'assert_cash_dispute%' OR p.proname='protect_cash_payment_dispute') AND a.grantee=0 AND a.privilege_type='EXECUTE'`
    assert.equal(publicFunctions,0)
    const id=await insertCase(db,f,{claimed:'60.00'})
    await assert.rejects(insertCase(db,f,{claimed:'41.00'}),/dispute_coverage/)
    const foreign=await fixture(db)
    await assert.rejects(insertCase(db,f,{companyId:foreign.company.id,claimed:'1.00'}),/dispute_scope/)
    await assert.rejects(db.$executeRaw`UPDATE cash_payment_disputes SET claimed=10 WHERE id=${id}::uuid`,/dispute_immutable/)
    await assert.rejects(db.$executeRaw`DELETE FROM cash_payment_disputes WHERE id=${id}::uuid`,/dispute_immutable/)
    await db.$executeRaw`INSERT INTO cash_dispute_commands(company_id,branch_id,actor_id,action,request_key,content_hash,result) VALUES(${f.company.id}::uuid,${f.branch.id}::uuid,${f.user.id}::uuid,'CREATE',gen_random_uuid(),${'a'.repeat(64)},'{}')`
    await assert.rejects(db.$executeRaw`UPDATE cash_dispute_commands SET result='{"changed":true}' WHERE company_id=${f.company.id}::uuid`,/dispute_immutable/)
  }finally{await db.$disconnect()}
})
test('dispute children cannot divert a receipt restriction to another customer or overreserve funds',{skip:!url,timeout:240000},async()=>{
  const {db}=await qaSchema(url)
  try{
    const f=await fixture(db),id=await insertCase(db,f)
    await assert.rejects(db.$executeRaw`INSERT INTO customer_receipt_restrictions(payment_id,dispute_id,company_id,branch_id,customer_id,held) VALUES(${f.paymentId}::uuid,${id}::uuid,${f.company.id}::uuid,${f.branch.id}::uuid,${f.customer.id}::uuid,101)`,/dispute_receipt_budget/)
    const other=await db.supplier.create({data:{company_id:f.company.id,name:'Otro cliente',contact:'QA',party_type:'CUSTOMER'}})
    await assert.rejects(db.$executeRaw`INSERT INTO customer_receipt_restrictions(payment_id,dispute_id,company_id,branch_id,customer_id,held) VALUES(${f.paymentId}::uuid,${id}::uuid,${f.company.id}::uuid,${f.branch.id}::uuid,${other.id}::uuid,1)`,/dispute_scope|foreign key/)
    await db.$executeRaw`INSERT INTO customer_receipt_restrictions(payment_id,dispute_id,company_id,branch_id,customer_id,held) VALUES(${f.paymentId}::uuid,${id}::uuid,${f.company.id}::uuid,${f.branch.id}::uuid,${f.customer.id}::uuid,100)`
    const [row]=await db.$queryRaw`SELECT held::text FROM customer_receipt_restrictions WHERE dispute_id=${id}::uuid`
    assert.equal(row.held,'100.00')
  }finally{await db.$disconnect()}
})
test('a monetary disposition requires an approved proposal and cannot exceed its customer allocation',{skip:!url,timeout:240000},async()=>{
  const {db}=await qaSchema(url)
  try{
    const f=await fixture(db),id=await insertCase(db,f)
    await db.$executeRaw`INSERT INTO cash_dispute_events(dispute_id,company_id,branch_id,kind,principal,economic_on,reference,actor_id) VALUES(${id}::uuid,${f.company.id}::uuid,${f.branch.id}::uuid,'BANK_DEBIT',100,'2026-11-22','QA-RETIRO',${f.user.id}::uuid)`
    const [result]=await db.$queryRaw`INSERT INTO cash_dispute_proposals(dispute_id,company_id,branch_id,kind,payload,preview_key,expected_version,proposed_by_id)
      VALUES(${id}::uuid,${f.company.id}::uuid,${f.branch.id}::uuid,'RESULT','{"won":"0.00","lost":"100.00"}',${'b'.repeat(64)},1,${f.user.id}::uuid) RETURNING id`
    await db.$executeRaw`UPDATE cash_dispute_proposals SET status='APPROVED',decided_by_id=${f.other.id}::uuid,decided_at=now() WHERE id=${result.id}::uuid`
    await db.$executeRaw`UPDATE cash_payment_disputes SET status='LOST',lost=100,version=version+1 WHERE id=${id}::uuid`
    const [p]=await db.$queryRaw`INSERT INTO cash_dispute_proposals(dispute_id,company_id,branch_id,kind,payload,preview_key,expected_version,proposed_by_id)
      VALUES(${id}::uuid,${f.company.id}::uuid,${f.branch.id}::uuid,'DISPOSITION','{"customerPrincipal":"20.00","absorbedPrincipal":"80.00"}',${'b'.repeat(64)},2,${f.user.id}::uuid) RETURNING id`
    const add=amount=>db.$executeRaw`INSERT INTO cash_dispute_lots(dispute_id,company_id,branch_id,proposal_id,kind,principal) VALUES(${id}::uuid,${f.company.id}::uuid,${f.branch.id}::uuid,${p.id}::uuid,'CUSTOMER_CHARGE',${amount}::numeric)`
    await assert.rejects(add('20.00'),/dispute_proposal_required/)
    await db.$executeRaw`UPDATE cash_dispute_proposals SET status='APPROVED',decided_by_id=${f.other.id}::uuid,decided_at=now() WHERE id=${p.id}::uuid`
    await assert.rejects(add('21.00'),/dispute_proposal_budget/)
    await add('20.00')
    const [{principal}]=await db.$queryRaw`SELECT sum(principal)::text AS principal FROM cash_dispute_lots WHERE dispute_id=${id}::uuid`
    assert.equal(principal,'20.00')
  }finally{await db.$disconnect()}
})
test('an unrelated approval cannot authorize a different case decision or an excessive fee compensation',{skip:!url,timeout:240000},async()=>{
  const {db}=await qaSchema(url)
  try {
    const f=await fixture(db),id=await insertCase(db,f)
    const [p]=await db.$queryRaw`INSERT INTO cash_dispute_proposals(dispute_id,company_id,branch_id,kind,payload,preview_key,expected_version,proposed_by_id)
      VALUES(${id}::uuid,${f.company.id}::uuid,${f.branch.id}::uuid,'SUBMIT','{}',${'b'.repeat(64)},1,${f.user.id}::uuid) RETURNING id`
    await db.$executeRaw`UPDATE cash_dispute_proposals SET status='APPROVED',decided_by_id=${f.other.id}::uuid,decided_at=now() WHERE id=${p.id}::uuid`
    await assert.rejects(db.$executeRaw`UPDATE cash_payment_disputes SET status='LOST',lost=100,version=2 WHERE id=${id}::uuid`,/dispute_decision_required/)
    const [e]=await db.$queryRaw`INSERT INTO cash_dispute_events(dispute_id,company_id,branch_id,kind,principal,fee,economic_on,reference,actor_id) VALUES(${id}::uuid,${f.company.id}::uuid,${f.branch.id}::uuid,'BANK_DEBIT',0,5,'2026-11-23','QA-COMISION',${f.user.id}::uuid) RETURNING id`
    const compensate=fee=>db.$executeRaw`INSERT INTO cash_dispute_events(dispute_id,company_id,branch_id,kind,principal,fee,reversal_of_id,economic_on,reference,actor_id) VALUES(${id}::uuid,${f.company.id}::uuid,${f.branch.id}::uuid,'COMPENSATION',0,${fee}::numeric,${e.id}::uuid,'2026-11-23','QA-REVERSO',${f.user.id}::uuid)`
    await assert.rejects(compensate('6'),/dispute_compensation/)
    await compensate('3')
    await assert.rejects(compensate('3'),/dispute_compensation/)
  } finally {await db.$disconnect()}
})
test('an approved cancellation cannot hide an outstanding bank withdrawal',{skip:!url,timeout:240000},async()=>{
  const {db}=await qaSchema(url)
  try {
    const f=await fixture(db),id=await insertCase(db,f)
    await db.$executeRaw`INSERT INTO cash_dispute_events(dispute_id,company_id,branch_id,kind,principal,economic_on,reference,actor_id) VALUES(${id}::uuid,${f.company.id}::uuid,${f.branch.id}::uuid,'BANK_DEBIT',20,'2026-11-23','QA-RETIRO',${f.user.id}::uuid)`
    const [p]=await db.$queryRaw`INSERT INTO cash_dispute_proposals(dispute_id,company_id,branch_id,kind,payload,preview_key,expected_version,proposed_by_id)
      VALUES(${id}::uuid,${f.company.id}::uuid,${f.branch.id}::uuid,'CANCEL','{}',${'b'.repeat(64)},1,${f.user.id}::uuid) RETURNING id`
    await db.$executeRaw`UPDATE cash_dispute_proposals SET status='APPROVED',decided_by_id=${f.other.id}::uuid,decided_at=now() WHERE id=${p.id}::uuid`
    await assert.rejects(db.$executeRaw`UPDATE cash_payment_disputes SET status='CANCELLED',version=2 WHERE id=${id}::uuid`,/dispute_cancel_has_effects/)
  } finally {await db.$disconnect()}
})
