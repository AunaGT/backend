const {PrismaClient}=require('@prisma/client')
const {randomUUID,createHash}=require('node:crypto')
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process')
function selectAppointmentsMigration(value='core') {
  const allowed={core:'202610120002_appointments_core',flexible:'202610120003_appointments_flexible',unified:'202610120004_appointments_unified_services',commercial:'202610130001_appointments_commercial'}
  if(!Object.hasOwn(allowed,value)) throw Error('Migración de Agenda no permitida')
  return allowed[value]
}
const migrationSql=(selection='core')=>fs.readFileSync(path.join(__dirname,'../prisma/migrations',selectAppointmentsMigration(selection),'migration.sql'),'utf8')
const hash=data=>createHash('sha256').update(data).digest('hex')
const statements=sql=>sql.replace(/^--[^\n]*$/gm,'').split(';').map(s=>s.trim()).filter(Boolean)
function stagingUrl(env=process.env){
  if(env.AUNA_APPOINTMENTS_STAGING_APPROVAL!=='approved')throw Error('Falta aprobación explícita de despliegue de Agenda')
  if(env.APPOINTMENTS_MIGRATION==='commercial'&&env.AUNA_APPOINTMENTS_COMMERCIAL_APPROVAL!=='approved')throw Error('Falta aprobación específica de la migración comercial de Agenda')
  let url;try{url=new URL(env.APPOINTMENTS_STAGING_DATABASE_URL)}catch{throw Error('Falta URL explícita del destino')}
  if(!['postgres:','postgresql:'].includes(url.protocol)||url.host!==env.APPOINTMENTS_CONFIRM_HOST||decodeURIComponent(url.pathname.slice(1))!==env.APPOINTMENTS_CONFIRM_DATABASE)throw Error('Host o base no coincide con el destino confirmado')
  for(const key of url.searchParams.keys())if(!['sslmode','connect_timeout','connection_limit','pool_timeout','schema'].includes(key))throw Error('Opción de conexión no permitida')
  url.searchParams.set('schema','public');url.searchParams.set('connect_timeout','10')
  return url.toString()
}
async function rehearseAppointmentsMigration(url,selection='core'){
  selectAppointmentsMigration(selection)
  if(selection==='commercial')throw Error('La migración comercial requiere ensayar el respaldo restaurado, no un esquema vacío')
  const db=new PrismaClient({datasources:{db:{url}}}),schema='appointments_qa_'+randomUUID().replace(/-/g,'')
  let created=false
  try{
    const sql=selection==='core'?migrationSql():migrationSql('core')+'\n'+migrationSql('flexible')+(selection==='unified'?'\n'+migrationSql('unified'):'')
    const backfill=`UPDATE "service_schedule_profiles" SET "scheduling_style" = CASE WHEN "mode" = 'GROUP' THEN 'CLASS' ELSE 'APPOINTMENT' END`
    if(/"public"\./.test(sql)||statements(sql).some(s=>/^(?:DROP|TRUNCATE|DELETE|UPDATE)\b/i.test(s)&&!(selection==='unified'&&s===backfill)))throw Error('SQL de Agenda no es aditivo/aislado')
    await db.$transaction(async tx=>{
      await tx.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);created=true
      await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}"`)
      for(const table of ['companies','users'])await tx.$executeRawUnsafe(`CREATE TABLE "${table}" (id UUID PRIMARY KEY)`)
      for(const table of ['branches','products','suppliers','employees'])await tx.$executeRawUnsafe(`CREATE TABLE "${table}" (id UUID PRIMARY KEY, company_id UUID NOT NULL)`)
      for(const statement of statements(sql))await tx.$executeRawUnsafe(statement)
      const fks=await tx.$queryRaw`SELECT n.nspname AS child,p.nspname AS parent FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace JOIN pg_class r ON r.oid=c.confrelid JOIN pg_namespace p ON p.oid=r.relnamespace WHERE c.contype='f' AND n.nspname=${schema}`
      if(fks.length<20||fks.some(f=>f.child!==schema||f.parent!==schema))throw Error('FK fuera del esquema aislado')
    },{timeout:60000,maxWait:10000})
    return {schema,checks:['SQL exacto ejecutado','FK aisladas','sin cambios en public']}
  }finally{try{if(created)await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)}finally{await db.$disconnect()}}
}
function pgEnv(url){return {...process.env,PGHOST:url.hostname,PGPORT:url.port||'5432',PGDATABASE:decodeURIComponent(url.pathname.slice(1)),PGUSER:decodeURIComponent(url.username),PGPASSWORD:decodeURIComponent(url.password),PGSSLMODE:url.searchParams.get('sslmode')||'require',PGCONNECT_TIMEOUT:'15'}}
function createBackup(raw,selection='core'){
  const migration=selectAppointmentsMigration(selection)
  const url=new URL(raw),base=path.join(os.homedir(),'.local/share/auna-backups')
  fs.mkdirSync(base,{recursive:true,mode:0o700})
  const dir=fs.mkdtempSync(path.join(base,'appointments-'));fs.chmodSync(dir,0o700)
  const file=path.join(dir,'staging-public.dump'),result=spawnSync('pg_dump',['--format=custom','--schema=public','--no-owner','--no-acl','--file',file],{env:pgEnv(url),timeout:120000,stdio:'pipe'})
  if(result.status!==0)throw Error('Backup falló; no se aplicó la migración')
  fs.chmodSync(file,0o600)
  if(fs.statSync(file).size<1000||spawnSync('pg_restore',['--list',file],{stdio:'pipe',timeout:30000}).status!==0)throw Error('Backup no verificable')
  const receipt=path.join(dir,'receipt.json')
  fs.writeFileSync(receipt,JSON.stringify({host:url.host,database:decodeURIComponent(url.pathname.slice(1)),file,sha256:hash(fs.readFileSync(file)),migration,migrationChecksum:hash(migrationSql(selection)),createdAt:new Date().toISOString()}),{mode:0o600,flag:'wx'})
  return receipt
}
function validateBackupReceipt(raw,receipt,selection,checksum,now=Date.now()) {
  const url=new URL(raw),created=new Date(receipt.createdAt).getTime()
  if(receipt.host!==url.host||receipt.database!==decodeURIComponent(url.pathname.slice(1))||receipt.migration!==selectAppointmentsMigration(selection)||receipt.migrationChecksum!==checksum||!Number.isFinite(created)||now-created>86400000||created>now)
    throw Error('Backup distinto, vencido o alterado')
}
function verifyBackup(raw,receiptPath,selection='core'){
  if(!receiptPath||!path.isAbsolute(receiptPath))throw Error('Falta comprobante absoluto de backup')
  const receipt=JSON.parse(fs.readFileSync(receiptPath,'utf8'))
  validateBackupReceipt(raw,receipt,selection,hash(migrationSql(selection)))
  if(!receipt.file||hash(fs.readFileSync(receipt.file))!==receipt.sha256)throw Error('Backup distinto, vencido o alterado')
  if(spawnSync('pg_restore',['--list',receipt.file],{stdio:'pipe',timeout:30000}).status!==0)throw Error('Backup no verificable')
  return receipt
}
function priorChecksums(){return Object.fromEntries(['core','flexible','unified'].map(key=>[key,hash(migrationSql(key))]))}
function validateRestoreProof(receipt,checksum,expected=priorChecksums(),now=Date.now()){
  const at=new Date(receipt.restoreVerifiedAt).getTime()
  if(receipt.restoreVerifiedChecksum!==receipt.sha256||receipt.restoreMigrationChecksum!==checksum||!Number.isFinite(at)||at>now||now-at>86400000||
    !/^(?:127\.0\.0\.1|localhost|\[::1\]):\d+\/[A-Za-z0-9_-]+$/.test(receipt.restoreTarget||'')||Object.keys(expected).some(key=>receipt.priorMigrationChecksums?.[key]!==expected[key]))throw Error('Falta ensayo reciente del respaldo exacto y de sus migraciones previas en una base local')
}
const commercialPreservationTables=['companies','users','branches','products','suppliers','employees','roles','permissions','role_permissions','company_modules','system_settings','commercial_documents','commercial_document_lines','commercial_document_sales','sales','sale_items','customer_payments','sale_payment_entries','product_stocks','product_stock_locations','stock_movements','stock_reservations','journal_entries','journal_lines','appointment_sessions','appointment_bookings','appointment_waitlist','appointment_history','appointment_requests','service_schedule_profiles','schedule_resources']
const commercialNewColumns={service_schedule_profiles:['public_instructions','completion_policy'],appointment_sessions:['completion_policy','actual_completed_at','commercial_completion_confirmed_at'],commercial_document_lines:['service_schedule_snapshot'],sales:['settlement_source']}
function safeSchema(schema){if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema))throw Error('Esquema no válido');return schema}
async function commercialFingerprint(tx,schema='public'){
  safeSchema(schema)
  const result={}
  for(const table of commercialPreservationTables){
    const omit=(commercialNewColumns[table]||[]).map(column=>`'${column}'`).join(',')
    const [row]=await tx.$queryRawUnsafe(`SELECT count(*)::text AS count,md5(COALESCE(string_agg((to_jsonb(t)${omit?`-ARRAY[${omit}]::text[]`:''})::text,',' ORDER BY (to_jsonb(t)${omit?`-ARRAY[${omit}]::text[]`:''})::text),'')) AS fingerprint FROM "${schema}"."${table}" t`)
    result[table]=row
  }
  return result
}
async function validateCommercialSchema(tx,schema='public'){
  const rows=await tx.$queryRaw`SELECT table_name,column_name,column_default,is_nullable FROM information_schema.columns WHERE table_schema=${schema} AND table_name IN ('appointment_sessions','service_schedule_profiles','sales','appointment_history')`
  const find=(table,column)=>rows.find(r=>r.table_name===table&&r.column_name===column)
  for(const table of ['appointment_sessions','service_schedule_profiles'])if(!find(table,'completion_policy')?.column_default?.includes('MANUAL'))throw Error('Default de cierre incompatible')
  if(!find('sales','settlement_source')?.column_default?.includes('LEGACY')||find('appointment_history','actor_id')?.is_nullable!=='YES')throw Error('Esquema histórico incompatible')
  const constraints=await tx.$queryRaw`SELECT c.conname FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname=${schema}`
  for(const name of ['appointment_completion_policy_check','service_completion_policy_check','allocation_sale_return_source_check','refund_rules_check','sale_settlement_source_check','appointment_request_result_check'])if(!constraints.some(c=>c.conname===name))throw Error('Faltan constraints comerciales')
  const indexes=await tx.$queryRaw`SELECT indexname FROM pg_indexes WHERE schemaname=${schema}`
  if(!indexes.some(i=>i.indexname==='engagement_history_attempt_key'))throw Error('Falta unicidad de historial comercial')
}
async function runCommercialDelta(tx,schema='public'){
  safeSchema(schema)
  await tx.$executeRawUnsafe(`LOCK TABLE ${commercialPreservationTables.map(t=>`"${schema}"."${t}"`).join(',')} IN SHARE MODE`)
  const expected=priorChecksums()
  for(const [key,checksum] of Object.entries(expected)){
    const migration=selectAppointmentsMigration(key)
    const rows=await tx.$queryRawUnsafe(`SELECT checksum,finished_at FROM "${schema}"._prisma_migrations WHERE migration_name=$1 AND rolled_back_at IS NULL`,migration)
    if(rows.length!==1||!rows[0].finished_at||rows[0].checksum!==checksum)throw Error('Migración previa ausente, incompleta o distinta')
  }
  const before=await commercialFingerprint(tx,schema),sql=migrationSql('commercial')
  if(/"public"\./.test(sql)||statements(sql).some(s=>/^(?:DROP|TRUNCATE|DELETE|UPDATE)\b/i.test(s)))throw Error('Delta comercial no aditiva')
  await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}"`)
  for(const statement of statements(sql))await tx.$executeRawUnsafe(statement)
  const after=await commercialFingerprint(tx,schema)
  if(JSON.stringify(before)!==JSON.stringify(after))throw Error('Datos de negocio, módulos o permisos alterados; transacción revertida')
  await validateCommercialSchema(tx,schema)
  return {fingerprints:after,priorMigrationChecksums:expected}
}
async function rehearseRestoredCommercialMigration(raw,receiptPath,localRaw){
  const receipt=verifyBackup(raw,receiptPath,'commercial')
  let local;try{local=new URL(localRaw)}catch{throw Error('Falta destino local vacío para restaurar')}
  if(!['postgres:','postgresql:'].includes(local.protocol)||!['127.0.0.1','localhost','[::1]'].includes(local.hostname)||local.searchParams.has('schema')||!/^\/[A-Za-z0-9_-]+$/.test(local.pathname))throw Error('El ensayo solo acepta una base local separada')
  const db=new PrismaClient({datasources:{db:{url:local.toString()}}})
  try{
    const [existing]=await db.$queryRaw`SELECT count(*)::int AS count FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public' AND t.relkind IN ('r','p')`
    if(existing.count!==0)throw Error('La base de restauración no está vacía; no se sobrescribe')
    const inventory=spawnSync('pg_restore',['--list',receipt.file],{timeout:30000,encoding:'utf8',stdio:'pipe'})
    if(inventory.status!==0)throw Error('No se pudo verificar el inventario del respaldo')
    // A fresh PostgreSQL database already owns public; restore its contents without recreating that namespace.
    const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'auna-restore-list-')),listFile=path.join(scratch,'archive.list')
    let restored
    try{
      fs.writeFileSync(listFile,inventory.stdout.split('\n').filter(line=>!/^\d+; \d+ \d+ SCHEMA - public /.test(line)).join('\n'),{mode:0o600})
      restored=spawnSync('pg_restore',['--exit-on-error','--no-owner','--no-acl','--use-list',listFile,'--dbname',decodeURIComponent(local.pathname.slice(1)),receipt.file],{env:pgEnv(local),timeout:120000,stdio:'pipe'})
    }finally{if(fs.existsSync(listFile))fs.unlinkSync(listFile);fs.rmdirSync(scratch)}
    if(restored.status!==0)throw Error('No se pudo restaurar el respaldo; destino local conservado para revisión')
    const proof=await db.$transaction(tx=>runCommercialDelta(tx),{timeout:60000,maxWait:10000})
    const result={...receipt,restoreVerifiedChecksum:receipt.sha256,restoreMigrationChecksum:hash(migrationSql('commercial')),restoreVerifiedAt:new Date().toISOString(),restoreTarget:`${local.host}${local.pathname}`,priorMigrationChecksums:proof.priorMigrationChecksums,preservationFingerprints:proof.fingerprints}
    fs.writeFileSync(receiptPath,JSON.stringify(result),{mode:0o600})
    return {checks:['Respaldo exacto restaurado','SQL exacta ensayada','Datos, módulos y permisos preservados','Defaults y constraints comprobados'],target:result.restoreTarget}
  }finally{await db.$disconnect()}
}
async function applyMigration(raw,receiptPath,selection='core'){
  if(selection==='commercial')stagingUrl({...process.env,APPOINTMENTS_MIGRATION:'commercial',APPOINTMENTS_STAGING_DATABASE_URL:raw})
  const receipt=verifyBackup(raw,receiptPath,selection),MIGRATION=selectAppointmentsMigration(selection)
  if(selection==='commercial')validateRestoreProof(receipt,hash(migrationSql(selection)))
  if(selection!=='core'&&(receipt.restoreVerifiedChecksum!==receipt.sha256||receipt.restoreMigrationChecksum!==hash(migrationSql(selection))))throw Error('Falta ensayo del respaldo restaurado en una base local')
  if(selection==='core')await rehearseAppointmentsMigration(raw)
  const db=new PrismaClient({datasources:{db:{url:raw}}}),checksum=hash(migrationSql(selection))
  try{
    return await db.$transaction(async tx=>{
      await tx.$executeRawUnsafe("SET LOCAL lock_timeout TO '15s'")
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${MIGRATION},0))`
      const old=await tx.$queryRaw`SELECT checksum,finished_at FROM public._prisma_migrations WHERE migration_name=${MIGRATION} AND rolled_back_at IS NULL`
      if(old.length){if(old.length!==1||old[0].checksum!==checksum||!old[0].finished_at)throw Error('Migración previa distinta o incompleta');return 'Ya aplicada con el mismo checksum'}
      if(selection==='commercial'){
        const proof=await runCommercialDelta(tx)
        await tx.$executeRaw`INSERT INTO public._prisma_migrations(id,checksum,migration_name,finished_at,started_at,applied_steps_count) VALUES(${randomUUID()},${checksum},${MIGRATION},NOW(),NOW(),1)`
        return {migration:MIGRATION,historyPreserved:true,proof,activation:'Sin cambios en módulos ni permisos'}
      }
      if(selection!=='core'){
        const core=await tx.$queryRaw`SELECT checksum,finished_at FROM public._prisma_migrations WHERE migration_name='202610120002_appointments_core' AND rolled_back_at IS NULL`
        if(core.length!==1||!core[0].finished_at||core[0].checksum!==hash(migrationSql('core')))throw Error('Core de Agenda ausente, incompleto o distinto')
        if(selection==='unified'){
          const flexible=await tx.$queryRaw`SELECT checksum,finished_at FROM public._prisma_migrations WHERE migration_name='202610120003_appointments_flexible' AND rolled_back_at IS NULL`
          if(flexible.length!==1||!flexible[0].finished_at||flexible[0].checksum!==hash(migrationSql('flexible')))throw Error('Agenda flexible ausente, incompleta o distinta')
        }
        await tx.$executeRawUnsafe('LOCK TABLE public.appointment_sessions,public.appointment_bookings,public.appointment_waitlist,public.appointment_history,public.appointment_requests,public.service_schedule_profiles,public.schedule_resources IN SHARE MODE')
      }
      await tx.$executeRawUnsafe('LOCK TABLE public.companies,public.users,public.branches,public.products,public.suppliers,public.employees IN SHARE MODE')
      const counts=()=>tx.$queryRawUnsafe('SELECT (SELECT count(*)::text FROM public.products) AS products,(SELECT count(*)::text FROM public.suppliers) AS contacts,(SELECT count(*)::text FROM public.employees) AS employees,(SELECT count(*)::text FROM public.branches) AS branches,(SELECT count(*)::text FROM public.companies) AS companies,(SELECT count(*)::text FROM public.users) AS users')
      const omitSession=selection==='flexible'?"-ARRAY['record_type','purpose','title','organizer_id','venue','estimated_attendance','outbound_minutes','setup_minutes','teardown_minutes','return_minutes']":''
      const omitType=selection==='flexible'?"-'session_type'":''
      const snapshot=()=>tx.$queryRawUnsafe(`SELECT md5(COALESCE(string_agg((to_jsonb(s)${omitSession})::text,',' ORDER BY s.id),'')) AS sessions FROM public.appointment_sessions s UNION ALL SELECT md5(COALESCE(string_agg((to_jsonb(b)${omitType})::text,',' ORDER BY b.id),'')) FROM public.appointment_bookings b UNION ALL SELECT md5(COALESCE(string_agg((to_jsonb(w)${omitType})::text,',' ORDER BY w.id),'')) FROM public.appointment_waitlist w UNION ALL SELECT md5(COALESCE(string_agg(to_jsonb(h)::text,',' ORDER BY h.id),'')) FROM public.appointment_history h${selection==='unified'?" UNION ALL SELECT md5(COALESCE(string_agg((to_jsonb(p)-ARRAY['scheduling_style','duration_policy'])::text,',' ORDER BY p.id),'')) FROM public.service_schedule_profiles p":''}`)
      const before=await counts(),historyBefore=selection!=='core'?await snapshot():null
      await tx.$executeRawUnsafe('SET LOCAL search_path TO public')
      for(const statement of statements(migrationSql(selection)))await tx.$executeRawUnsafe(statement)
      const after=await counts();if(JSON.stringify(before)!==JSON.stringify(after))throw Error('Conteos alterados; transacción revertida')
      if(historyBefore&&JSON.stringify(historyBefore)!==JSON.stringify(await snapshot()))throw Error('Historial o reservas alterados; transacción revertida')
      if(selection==='unified'){
        const invalid=await tx.$queryRawUnsafe(`SELECT count(*)::int AS total FROM public.service_schedule_profiles WHERE duration_policy <> 'FIXED' OR scheduling_style <> CASE WHEN mode='GROUP' THEN 'CLASS' ELSE 'APPOINTMENT' END`)
        if(invalid[0].total!==0)throw Error('Conversión de perfiles inesperada; transacción revertida')
      }
      await tx.$executeRaw`INSERT INTO public._prisma_migrations(id,checksum,migration_name,finished_at,started_at,applied_steps_count) VALUES(${randomUUID()},${checksum},${MIGRATION},NOW(),NOW(),1)`
      return {migration:MIGRATION,counts:after[0],historyPreserved:true,activation:'Sin cambios en módulos ni permisos'}
    },{timeout:60000,maxWait:10000})
  }finally{await db.$disconnect()}
}
async function main(){
  const mode=process.argv[2]
  if(!['--rehearse','--backup','--apply'].includes(mode))throw Error('Usa --rehearse, --backup o --apply; requieren aprobación explícita')
  require('../src/config/loadEnv')
  const raw=stagingUrl()
  const selection=process.env.APPOINTMENTS_MIGRATION||'core'
  selectAppointmentsMigration(selection)
  if(mode==='--rehearse')console.log(selection==='commercial'?await rehearseRestoredCommercialMigration(raw,process.env.APPOINTMENTS_BACKUP_RECEIPT,process.env.APPOINTMENTS_RESTORE_DATABASE_URL):await rehearseAppointmentsMigration(raw,selection))
  if(mode==='--backup')console.log('Backup privado verificado: '+createBackup(raw,selection))
  if(mode==='--apply')console.log(await applyMigration(raw,process.env.APPOINTMENTS_BACKUP_RECEIPT,selection))
}
if(require.main===module)main().catch(()=>{console.error('Operación detenida. Revisa destino, aprobación, backup y migración; no se exponen credenciales.');process.exitCode=1})
module.exports={stagingUrl,rehearseAppointmentsMigration,verifyBackup,selectAppointmentsMigration,validateBackupReceipt,createBackup,applyMigration,validateRestoreProof,commercialFingerprint,runCommercialDelta,rehearseRestoredCommercialMigration}
