const test = require('node:test'), assert = require('node:assert/strict'), { randomUUID } = require('node:crypto'), fs = require('node:fs'), path = require('node:path')
const { qaSchema, fixture } = require('./helpers/cashDailyQa.cjs')
const url = process.env.AUNA_CASH_DAILY_QA_URL
const ddl = () => fs.readFileSync(path.join(__dirname,'../prisma/migrations/20261106100000_cash_day_close_lock/migration.sql'),'utf8')
const deferred = () => { let resolve; const promise = new Promise(r=>resolve=r); return {promise,resolve} }
async function blockedBy(db, waiter, holder) {
  const deadline=Date.now()+5000
  while(Date.now()<deadline){const [r]=await db.$queryRaw`SELECT ${holder}::int=ANY(pg_blocking_pids(${waiter}::int)) AS blocked`;if(r.blocked)return;await new Promise(setImmediate)}
  assert.fail('The PostgreSQL lock graph did not show the expected contention')
}
test('a finalized operational day cannot acquire new ledger turns in either order of the race', {skip:!url,timeout:120000},async t=>{
  const qa=await qaSchema(url,{fixes:false}),{db}=qa
  try{
    const f=await fixture(db), api=require('../src/modules/cash-closure/dailyConsolidation')
    const date='2026-01-03', staff={...f.scope,canView:true,canFinalize:true}
    const insert=(tx,registerId,day=date)=>tx.$executeRaw`INSERT INTO cash_register_sessions(id,cash_register_id,opened_by_id,opening_float,updated_at,register_type,operation_mode,currency_code,business_date,business_timezone,money_event_version,opened_at)
      VALUES(${randomUUID()}::uuid,${registerId}::uuid,${f.user.id}::uuid,0,now(),(SELECT kind FROM cash_registers WHERE id=${registerId}::uuid),'INDIVIDUAL','GTQ',${day}::date,'America/Guatemala',1,${day+'T12:00:00Z'}::timestamptz)`
    const final=(tx,day=date)=>tx.$executeRaw`INSERT INTO cash_daily_consolidations(company_id,branch_id,business_date,content_hash,snapshot,finalized_by_id) VALUES(${f.company.id}::uuid,${f.branch.id}::uuid,${day}::date,${'a'.repeat(64)},'{}'::jsonb,${f.user.id}::uuid)`
    await final(db)
    await t.test('new DDL preserves all existing daily documents',async()=>{
      const before=await db.$queryRaw`SELECT to_jsonb(d) AS row FROM cash_daily_consolidations d ORDER BY id`
      qa.sql('BEGIN;\n'+ddl()+'\nCOMMIT;')
      assert.deepEqual(await db.$queryRaw`SELECT to_jsonb(d) AS row FROM cash_daily_consolidations d ORDER BY id`,before)
    })
    await t.test('post-finalization raw SQL and application opening are rejected, preserving the legacy snapshot',async()=>{
      const before=await db.$queryRaw`SELECT to_jsonb(d) AS row FROM cash_daily_consolidations d`
      await assert.rejects(insert(db,f.register2.id),/cash_day_closed/)
      const adoption=require('../src/services/cashEventAdoption'),boundary=require('../src/services/cashSessionBoundary')
      await assert.rejects(db.$transaction(async tx=>adoption.openEventSession(tx,staff,await boundary.lockScopedRegister(tx,staff,f.register2.id),{openingFloat:'0.00',notes:null,now:new Date(date+'T12:00:00Z')})),e=>e.status===409&&e.code==='CASH_DAY_CLOSED'&&e.message.includes(date))
      assert.deepEqual(await db.$queryRaw`SELECT to_jsonb(d) AS row FROM cash_daily_consolidations d`,before)
      const legacyId=randomUUID()
      await db.$executeRaw`INSERT INTO cash_registers(id,branch_id,name,code,updated_at) VALUES(${legacyId}::uuid,${f.branch.id}::uuid,'Anterior','OLD',now())`
      await db.$executeRaw`INSERT INTO cash_register_sessions(id,cash_register_id,opened_by_id,opening_float,updated_at,business_date) VALUES(${randomUUID()}::uuid,${legacyId}::uuid,${f.user.id}::uuid,0,now(),${date}::date)`
      const [legacy]=await db.$queryRaw`SELECT money_event_version FROM cash_register_sessions WHERE cash_register_id=${legacyId}::uuid`;assert.equal(legacy.money_event_version,0)
    })
    await t.test('opening first blocks finalization until committed, then the day reports OPERATING',async()=>{
      const ready=deferred(),release=deferred(),started=deferred(),day='2026-01-04'
      const opening=db.$transaction(async tx=>{await insert(tx,f.register2.id,day);const [p]=await tx.$queryRaw`SELECT pg_backend_pid()::int AS id`;ready.resolve(p.id);await release.promise},{timeout:20000})
      const holder=await ready.promise
      const closing=db.$transaction(async tx=>{const [p]=await tx.$queryRaw`SELECT pg_backend_pid()::int AS id`;started.resolve(p.id);return api.finalizeDay(tx,staff,day,{contentKey:'f'.repeat(64)})},{timeout:20000});closing.catch(()=>{})
      try{await blockedBy(db,await started.promise,holder)}finally{release.resolve()}
      await opening;await assert.rejects(closing,e=>e.code==='CASH_DAY_BLOCKED')
    })
    await t.test('finalization first blocks opening, another date proceeds, then opening fails without a turn',async()=>{
      const ready=deferred(),release=deferred(),started=deferred(),day='2026-01-05'
      const closing=db.$transaction(async tx=>{await final(tx,day);const [p]=await tx.$queryRaw`SELECT pg_backend_pid()::int AS id`;ready.resolve(p.id);await release.promise},{timeout:20000})
      const holder=await ready.promise
      const opening=db.$transaction(async tx=>{const [p]=await tx.$queryRaw`SELECT pg_backend_pid()::int AS id`;started.resolve(p.id);await insert(tx,f.virtual.id,day)},{timeout:20000});opening.catch(()=>{})
      try{
        await blockedBy(db,await started.promise,holder)
        await db.$transaction(tx=>insert(tx,f.virtual.id,'2026-01-06'),{timeout:3000})
        const branch=await db.branch.create({data:{company_id:f.company.id,name:'Independiente',code:'IND'}}),registerId=randomUUID()
        await db.$executeRaw`INSERT INTO cash_registers(id,branch_id,name,code,currency_code,money_event_version,updated_at) VALUES(${registerId}::uuid,${branch.id}::uuid,'Otra','OTR','GTQ',1,now())`
        await db.$transaction(tx=>insert(tx,registerId,day),{timeout:3000})
      }finally{release.resolve()}
      await closing;await assert.rejects(opening,/cash_day_closed/)
      const [count]=await db.$queryRaw`SELECT count(*)::int AS n FROM cash_register_sessions WHERE business_date=${day}::date AND cash_register_id=${f.virtual.id}::uuid`;assert.equal(count.n,0)
    })
  }finally{await db.$disconnect()}
})
