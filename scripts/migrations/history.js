const {identifier,fingerprintRows}=require('./inventory')
const {assertQaSchema}=require('./baselineSql')
const {baseline,payment}=require('./rehearsal')
const fail=code=>{throw Object.assign(new Error(code),{code})}
function location(r){
  if(r.qaSchema){assertQaSchema(r.qaSchema);assertQaSchema(r.qaAuditSchema);if(r.qaSchema===r.qaAuditSchema)fail('BASELINE_SCHEMA_INVALID');return {source:r.qaSchema,audit:r.qaAuditSchema,archived:'_prisma_migrations_original'}}
  return {source:'public',audit:'auna_migration_audit',archived:'_prisma_migrations_20261015'}
}
function ownerTag(r){
  if(!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(r.runId))fail('BASELINE_AUDIT_COLLISION')
  return 'auna:baseline:20261015:'+r.runId
}
async function auditStatus(db,r){
  return (await db.$queryRawUnsafe("SELECT n.oid::text AS oid,n.nspowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) AS owned,obj_description(n.oid,'pg_namespace') AS marker,NOT EXISTS(SELECT 1 FROM aclexplode(COALESCE(n.nspacl,acldefault('n',n.nspowner))) a WHERE a.grantee<>n.nspowner) AS restricted FROM pg_namespace n WHERE n.nspname=$1",location(r).audit))[0]
}
async function validateAudit(db,r,{allowOriginal=false}={}){
  const l=location(r),status=await auditStatus(db,r),prefix='_auna_attempt_'+r.runId.replaceAll('-','')
  if(!status?.owned||!status.restricted||status.marker!==ownerTag(r))fail('BASELINE_AUDIT_COLLISION')
  const objects=await db.$queryRawUnsafe("SELECT c.relname AS name,c.relkind::text AS kind,COALESCE(t.relname,c.relname) AS table FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_index i ON i.indexrelid=c.oid LEFT JOIN pg_class t ON t.oid=i.indrelid WHERE n.nspname=$1 UNION SELECT proname,'f',proname FROM pg_proc WHERE pronamespace=$1::regnamespace UNION SELECT typname,'e',typname FROM pg_type WHERE typnamespace=$1::regnamespace AND typtype IN ('e','d')",l.audit)
  for(const o of objects){
    if(!['r','i'].includes(o.kind))fail('BASELINE_AUDIT_COLLISION')
    if(allowOriginal&&o.table===l.archived)continue
    if(o.table!==prefix&&!new RegExp('^'+prefix+'_\\d+$').test(o.table))fail('BASELINE_AUDIT_COLLISION')
    if(o.kind==='r'){
      const saved=await table(db,l.audit,o.table)
      if(saved.rows.length>1||saved.rows.some(m=>m.migration_name!==baseline||m.checksum!==r.baselineChecksum||!m.finished_at||m.rolled_back_at))fail('BASELINE_AUDIT_COLLISION')
    }
  }
}
async function table(db,schema,name){
  const found=await db.$queryRawUnsafe("SELECT c.oid::text AS oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=$2 AND c.relkind='r'",schema,name)
  if(!found.length)return null
  const rows=await db.$queryRawUnsafe(`SELECT row_to_json(h)::text AS row FROM ${identifier(schema)}.${identifier(name)} h ORDER BY id`)
  return {oid:found[0].oid,hash:fingerprintRows(rows.map(r=>r.row)),rows:rows.map(r=>JSON.parse(r.row))}
}
async function inspectHistory(db,r){
  const l=location(r),original=await table(db,l.audit,l.archived),current=await table(db,l.source,'_prisma_migrations')
  if(!original){
    if(current?.oid!==r.historyOid||current.hash!==r.historyHash)fail('BASELINE_HISTORY_REVIEW_REQUIRED')
    return 'CAPTURED'
  }
  if(original.oid!==r.historyOid||original.hash!==r.historyHash)fail('BASELINE_HISTORY_REVIEW_REQUIRED')
  await validateAudit(db,r,{allowOriginal:true})
  if(!current||!current.rows.length)return 'ARCHIVED'
  const active=current.rows.filter(m=>!m.rolled_back_at)
  if(active.some(m=>!m.finished_at)||active.length!==current.rows.length||active.length>2)fail('BASELINE_HISTORY_REVIEW_REQUIRED')
  const base=active.filter(m=>m.migration_name===baseline&&m.checksum===r.baselineChecksum)
  const paid=active.filter(m=>m.migration_name===payment&&m.checksum===r.paymentChecksum)
  if(base.length!==1||base.length+paid.length!==active.length||paid.length>1)fail('BASELINE_HISTORY_REVIEW_REQUIRED')
  return paid.length?'PAYMENTS_APPLIED':'BASELINED'
}
async function archiveHistory(db,r){
  if(await inspectHistory(db,r)!=='CAPTURED')return
  const l=location(r)
  await db.$transaction(async tx=>{
    await tx.$executeRawUnsafe("SET LOCAL lock_timeout='10s'")
    await tx.$executeRawUnsafe(`LOCK TABLE ${identifier(l.source)}._prisma_migrations IN ACCESS EXCLUSIVE MODE`)
    if(await inspectHistory(tx,r)!=='CAPTURED')fail('BASELINE_HISTORY_REVIEW_REQUIRED')
    if(!await auditStatus(tx,r)){
      await tx.$executeRawUnsafe(`CREATE SCHEMA ${identifier(l.audit)}`)
      await tx.$executeRawUnsafe(`REVOKE ALL ON SCHEMA ${identifier(l.audit)} FROM PUBLIC,anon,authenticated,service_role`)
      await tx.$executeRawUnsafe(`COMMENT ON SCHEMA ${identifier(l.audit)} IS '${ownerTag(r)}'`)
    }else await validateAudit(tx,r)
    await tx.$executeRawUnsafe(`ALTER TABLE ${identifier(l.source)}._prisma_migrations SET SCHEMA ${identifier(l.audit)}`)
    await tx.$executeRawUnsafe(`ALTER TABLE ${identifier(l.audit)}._prisma_migrations RENAME TO ${identifier(l.archived)}`)
    await tx.$executeRawUnsafe(`REVOKE ALL ON TABLE ${identifier(l.audit)}.${identifier(l.archived)} FROM PUBLIC,anon,authenticated,service_role`)
    if(await inspectHistory(tx,r)!=='ARCHIVED')fail('BASELINE_HISTORY_REVIEW_REQUIRED')
  },{timeout:30000,maxWait:15000})
}
async function recoverHistory(db,r,{verifyBusiness}={}){
  let phase
  try{phase=await inspectHistory(db,r)}catch{fail('BASELINE_RECOVERY_REVIEW_REQUIRED')}
  if(phase==='PAYMENTS_APPLIED')fail('BASELINE_RECOVERY_REVIEW_REQUIRED')
  if(phase==='CAPTURED')return
  if(!verifyBusiness)fail('BASELINE_RECOVERY_REVIEW_REQUIRED')
  await verifyBusiness()
  const l=location(r),attemptBase='_auna_attempt_'+r.runId.replaceAll('-','')
  if(!/^_auna_attempt_[0-9a-f]{32}$/.test(attemptBase))fail('BASELINE_RECOVERY_REVIEW_REQUIRED')
  await db.$transaction(async tx=>{
    await tx.$executeRawUnsafe("SET LOCAL lock_timeout='10s'")
    await tx.$executeRawUnsafe(`LOCK TABLE ${identifier(l.audit)}.${identifier(l.archived)} IN ACCESS EXCLUSIVE MODE`)
    if(await inspectHistory(tx,r)!==phase)fail('BASELINE_RECOVERY_REVIEW_REQUIRED')
    const current=await table(tx,l.source,'_prisma_migrations')
    if(current){
      await tx.$executeRawUnsafe(`LOCK TABLE ${identifier(l.source)}._prisma_migrations IN ACCESS EXCLUSIVE MODE`)
      let attempt=attemptBase,suffix=0
      while(await table(tx,l.audit,attempt)){if(++suffix>1000)fail('BASELINE_RECOVERY_REVIEW_REQUIRED');attempt=attemptBase+'_'+suffix}
      const [pk]=await tx.$queryRawUnsafe("SELECT conname AS name FROM pg_constraint WHERE conrelid=$1::regclass AND contype='p'",`${identifier(l.source)}._prisma_migrations`)
      if(!pk)fail('BASELINE_RECOVERY_REVIEW_REQUIRED')
      await tx.$executeRawUnsafe(`ALTER TABLE ${identifier(l.source)}._prisma_migrations RENAME CONSTRAINT ${identifier(pk.name)} TO ${identifier(attempt+'_pkey')}`)
      await tx.$executeRawUnsafe(`ALTER TABLE ${identifier(l.source)}._prisma_migrations RENAME TO ${identifier(attempt)}`)
      if(l.source!==l.audit)await tx.$executeRawUnsafe(`ALTER TABLE ${identifier(l.source)}.${identifier(attempt)} SET SCHEMA ${identifier(l.audit)}`)
      await tx.$executeRawUnsafe(`REVOKE ALL ON TABLE ${identifier(l.audit)}.${identifier(attempt)} FROM PUBLIC,anon,authenticated,service_role`)
    }
    await tx.$executeRawUnsafe(`ALTER TABLE ${identifier(l.audit)}.${identifier(l.archived)} RENAME TO _prisma_migrations`)
    if(l.source!==l.audit)await tx.$executeRawUnsafe(`ALTER TABLE ${identifier(l.audit)}._prisma_migrations SET SCHEMA ${identifier(l.source)}`)
    if(await inspectHistory(tx,r)!=='CAPTURED')fail('BASELINE_RECOVERY_REVIEW_REQUIRED')
  },{timeout:30000,maxWait:15000})
}
async function withMigrationGate(db,work){
  const controller=new AbortController();let timer,pending
  try{
    return await db.$transaction(async tx=>{
      const [lock]=await tx.$queryRawUnsafe("SELECT pg_try_advisory_xact_lock(hashtextextended('auna:migrations:baseline:20261015',0)) AS acquired,pg_backend_pid() AS pid")
      if(!lock.acquired)fail('BASELINE_MIGRATION_BUSY')
      const check=async()=>{
        if(controller.signal.aborted)throw controller.signal.reason
        try{await tx.$queryRawUnsafe('SELECT 1 AS alive')}
        catch{const error=Object.assign(new Error('Migration guard lost'),{code:'BASELINE_GUARD_LOST'});controller.abort(error);throw error}
      }
      let checking=false
      timer=setInterval(()=>{if(!checking){checking=true;check().catch(()=>{}).finally(()=>{checking=false})}},5000)
      pending=Promise.resolve().then(()=>work({check,signal:controller.signal,pid:lock.pid}))
      return await pending
    },{timeout:300000,maxWait:15000})
  }catch(error){
    controller.abort(error)
    if(pending)await pending.catch(()=>{})
    throw error
  }finally{clearInterval(timer)}
}
function validateRehearsal(r,expected){
  if(!r||!r.installation||!r.historyRecovery||!r.qaCleaned||['sourceReceiptHash','baselineChecksum','paymentChecksum'].some(k=>r[k]!==expected[k]))fail('BASELINE_REHEARSAL_REQUIRED')
}
async function applyPaymentCommands(db,r,gate,run){
  if(!['BASELINED','PAYMENTS_APPLIED'].includes(await inspectHistory(db,r)))fail('BASELINE_PAYMENT_PHASE_INVALID')
  for(const args of [['migrate','deploy'],['generate'],['migrate','status']]){await gate.check();await run(args,gate.signal)}
  if(await inspectHistory(db,r)!=='PAYMENTS_APPLIED')fail('BASELINE_HISTORY_REVIEW_REQUIRED')
}
async function assertNoWriters(db,gatePid){
  const [visibility]=await db.$queryRawUnsafe("SELECT current_setting('is_superuser')='on' OR pg_has_role(current_user,'pg_read_all_stats','USAGE') AS visible")
  if(!visibility?.visible)fail('BASELINE_WRITER_VISIBILITY_REQUIRED')
  const peers=await db.$queryRawUnsafe("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND backend_type='client backend' AND pid<>pg_backend_pid() AND pid IS DISTINCT FROM $1::int AND state IS DISTINCT FROM 'idle'",gatePid??null)
  if(peers.length)fail('BASELINE_WRITER_DETECTED')
}
module.exports={inspectHistory,archiveHistory,recoverHistory,withMigrationGate,validateRehearsal,applyPaymentCommands,assertNoWriters,table,location,auditStatus}
