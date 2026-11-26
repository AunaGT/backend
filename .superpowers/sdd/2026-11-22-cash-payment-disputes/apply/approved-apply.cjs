// Aplicación dirigida de las dos migraciones de disputas y del registro de permisos. NO se ejecuta sin autorización concreta.
// Uso autorizado:  node approved-apply.cjs --apply-approved
// Ensayo local:    AUNA_DISPUTES_REHEARSAL_URL=postgresql://postgres@127.0.0.1:5432/auna_disputes_apply_rehearsal node approved-apply.cjs --rehearsal
// No regenera el cliente Prisma, no reinicia procesos y no abre los comandos (disputes.release.js sigue en false).
const root='/home/DiegoPatzan/Documents/CODE/Auna/deposito-backend'
const {createRequire}=require('node:module'),r=createRequire(root+'/package.json')
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{createHash,randomUUID}=require('node:crypto'),{spawnSync}=require('node:child_process')
const mode=process.argv[2]
assert.ok(['--apply-approved','--rehearsal'].includes(mode),'Explicit approved invocation required')
const rehearsal=mode==='--rehearsal'
if(rehearsal){
 const url=new URL(process.env.AUNA_DISPUTES_REHEARSAL_URL||'postgresql://invalid/none')
 assert.equal(url.hostname,'127.0.0.1','Rehearsal only on 127.0.0.1');assert.equal(url.pathname,'/auna_disputes_apply_rehearsal','Rehearsal only on its own database')
 process.env.DIRECT_URL=process.env.DATABASE_URL=url.toString()
}else r('./src/config/loadEnv')
const {PrismaClient}=r('@prisma/client'),{connectionIdentity,assertDevTarget}=r('./scripts/salesDevTarget')
// Mismo destino verificado y autorizado el 2026-11-20 (correcciones). Si el destino cambió, esto se detiene.
const identity='942b35dd260421000d366780c288408ec0c810ad9e14302c731ac0e27aa4ba12'
if(!rehearsal)for(const key of ['DIRECT_URL','DATABASE_URL']){assert.equal(connectionIdentity(process.env[key]),identity,'Target identity differs');assertDevTarget({connectionUrl:process.env[key],approvedHost:new URL(process.env[key]).hostname,approvedDatabase:'postgres',approved:true,approvedIdentity:identity})}
const out=path.join(__dirname,rehearsal?'rehearsal':'applied');fs.mkdirSync(out,{recursive:true,mode:0o700})
const migrations=[['20261122220000_cash_dispute_sources','2324ed0e28ce0875e7f128f5dcfd0e73a6aef7fbc607d9999568da43eccb0fba'],['20261122220100_cash_payment_disputes','41e05343b8c0cfd39456fc3c285025941256bbef2bb58f46eed18be2e351c5a7']]
const REGISTRAR_SHA='fe09cb451de31a21b7e6adcb80fcf858d4399062b68f40205672eaa1530f573a'
const digest=file=>createHash('sha256').update(fs.readFileSync(root+'/'+file)).digest('hex')
for(const [name,sha]of migrations)assert.equal(digest('prisma/migrations/'+name+'/migration.sql'),sha,'Migration file differs from the reviewed one: '+name)
assert.equal(digest('scripts/register-cash-permissions.js'),REGISTRAR_SHA,'Registrar differs from the reviewed one')
const definitions=r('./src/modules/cash-closure/permissions').disputePermissions,codes=definitions.map(d=>d.code)
assert.deepEqual(codes,['cash.disputes.view','cash.disputes.manage','cash.disputes.movements','cash.disputes.resolve','cash.disputes.charge_customer'])
const NEW_TABLES=['cash_payment_disputes','cash_dispute_events','cash_dispute_proposals','cash_dispute_commands','cash_dispute_lots','customer_receipt_restrictions','customer_dispute_charges','customer_dispute_charge_applications','customer_recovery_credits','customer_recovery_credit_applications','cash_dispute_settings','cash_refund_allocations']
const names=migrations.map(m=>m[0]),quote=s=>"'"+s.replaceAll("'","''")+"'"
const client=url=>new PrismaClient({datasources:{db:{url}},log:[]})
const db=client(process.env.DIRECT_URL)
const write=(name,data)=>fs.writeFileSync(path.join(out,name),JSON.stringify(data,null,2)+'\n',{mode:0o600})
// La columna nueva cash_settlements.recoveries (default 0) se excluye de la huella; aparte se exige que sea 0 en toda fila anterior.
const rowExpr=table=>table==='cash_settlements'?"to_jsonb(t)-'recoveries'":'to_jsonb(t)'
const tables=async tx=>(await tx.$queryRaw`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`).map(r=>r.tablename)
async function projection(tx,list){
 const result=[]
 for(const table of list){assert.match(table,/^[a-zA-Z_][a-zA-Z_0-9]*$/);const filter=table==='_prisma_migrations'?' WHERE migration_name NOT IN ('+names.map(quote).join(',')+')':''
  const [row]=await tx.$queryRawUnsafe(`SELECT count(*)::int AS count,md5(coalesce(string_agg(md5((${rowExpr(table)})::text),'' ORDER BY md5((${rowExpr(table)})::text)),'')) AS hash FROM public."${table}" t${filter}`);result.push({table,...row})}
 return result
}
async function canonical(tx){const row=await tx.role.findUnique({where:{system_key:'ADMIN'}});assert.ok(r('./src/modules/users/roles/policy').isSystemAdmin(row),'Canonical admin role not found');return row}
const permissions=tx=>tx.permission.findMany({orderBy:{id:'asc'}})
const grants=tx=>tx.rolePermission.findMany({orderBy:[{role_id:'asc'},{permission_id:'asc'}]})
function psql(input){
 const u=new URL(process.env.DIRECT_URL),env={...process.env,PGHOST:u.hostname,PGPORT:u.port||'5432',PGDATABASE:decodeURIComponent(u.pathname.slice(1)),PGUSER:decodeURIComponent(u.username),PGPASSWORD:decodeURIComponent(u.password),PGCONNECT_TIMEOUT:'10',PGSSLMODE:u.searchParams.get('sslmode')||(rehearsal?'disable':'require')}
 const result=spawnSync('psql',['-X','-q','-t','-A','-v','ON_ERROR_STOP=1'],{input,env,encoding:'utf8',timeout:180000,maxBuffer:10*1024*1024})
 if(result.status!==0){fs.writeFileSync(path.join(out,'sql-error.log'),String(result.stderr||'SQL failed'),{mode:0o600});throw Error('Directed SQL failed; inspect local diagnostic')}
 return result.stdout.trim()
}
const excluded=names.map(n=>quote(n).replaceAll("'","''")).join(',')
const protectedSql=`DO $$ DECLARE n text; e text; BEGIN
 FOR n IN SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename LOOP
   e:=CASE WHEN n='cash_settlements' THEN 'to_jsonb(t)-''recoveries''' ELSE 'to_jsonb(t)' END;
   EXECUTE format('LOCK TABLE public.%I IN SHARE MODE',n);
   EXECUTE format('INSERT INTO protected_baseline SELECT %L,count(*),md5(coalesce(string_agg(md5((%s)::text),'''' ORDER BY md5((%s)::text)),'''')) FROM public.%I t %s',n,e,e,n,
     CASE WHEN n='_prisma_migrations' THEN 'WHERE migration_name NOT IN (${excluded})' ELSE '' END);
 END LOOP;
 END $$;`
const afterSql=`DO $$ DECLARE old record; e text; now_count bigint; now_hash text; BEGIN
 FOR old IN SELECT * FROM protected_baseline ORDER BY table_name LOOP
   e:=CASE WHEN old.table_name='cash_settlements' THEN 'to_jsonb(t)-''recoveries''' ELSE 'to_jsonb(t)' END;
   EXECUTE format('SELECT count(*),md5(coalesce(string_agg(md5((%s)::text),'''' ORDER BY md5((%s)::text)),'''')) FROM public.%I t %s',e,e,old.table_name,
     CASE WHEN old.table_name='_prisma_migrations' THEN 'WHERE migration_name NOT IN (${excluded})' ELSE '' END) INTO now_count,now_hash;
   IF old.row_count<>now_count OR old.row_hash<>now_hash THEN RAISE EXCEPTION 'Preservation check failed for %',old.table_name; END IF;
 END LOOP;
 IF to_regclass('public.cash_settlements') IS NOT NULL AND EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='cash_settlements' AND column_name='recoveries') THEN
   EXECUTE 'SELECT count(*) FROM public.cash_settlements WHERE recoveries<>0' INTO now_count;
   IF now_count<>0 THEN RAISE EXCEPTION 'Preservation check failed for cash_settlements.recoveries'; END IF;
 END IF;
 END $$;`
async function migrate(name,sha){
 const previous=await db.$queryRaw`SELECT checksum,finished_at,rolled_back_at FROM public._prisma_migrations WHERE migration_name=${name}`
 if(previous.length){assert.equal(previous.length,1);assert.equal(previous[0].checksum,sha);assert.ok(previous[0].finished_at&&!previous[0].rolled_back_at);return {name,alreadyApplied:true}}
 // Cada migración en su propia transacción: los valores nuevos del enum confirman antes del DDL que los usa.
 const sql=`BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='90s'; SET LOCAL TIME ZONE 'UTC'; SET LOCAL search_path=public;
 SELECT pg_advisory_xact_lock(910020,192202);
 CREATE TEMP TABLE protected_baseline(table_name text,row_count bigint,row_hash text) ON COMMIT DROP;
 ${protectedSql}
 ${fs.readFileSync(root+'/prisma/migrations/'+name+'/migration.sql','utf8')}
 INSERT INTO public._prisma_migrations(id,checksum,finished_at,migration_name,logs,rolled_back_at,started_at,applied_steps_count) VALUES(${quote(randomUUID())},${quote(sha)},clock_timestamp(),${quote(name)},NULL,NULL,clock_timestamp(),1);
 ${afterSql}
 SELECT jsonb_build_object('name',${quote(name)},'preservedTableCount',count(*),'preservedRows',sum(row_count),'dataUnchanged',true) FROM protected_baseline;
 COMMIT;`
 fs.writeFileSync(path.join(out,name+'.approved.sql'),sql,{mode:0o600})
 const output=psql(sql),result=JSON.parse(output.split('\n').find(line=>line.startsWith('{')))
 console.log(JSON.stringify({stage:'migration-verified',...result}));return result
}
// Ninguna migración anterior del repositorio puede quedar pendiente: esta no se aplica sobre una base incompleta.
async function preflight(){
 const repo=fs.readdirSync(root+'/prisma/migrations').filter(n=>/^\d{14}_/.test(n)&&n<names[0]).sort()
 const applied=new Set((await db.$queryRaw`SELECT migration_name FROM public._prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`).map(r=>r.migration_name))
 const pending=repo.filter(n=>!applied.has(n))
 if(pending.length){write('pending-migrations.json',pending);throw Error('Earlier migrations are pending on the target ('+pending.length+'); they need their own authorization first. See pending-migrations.json')}
 const ours=await db.$queryRaw`SELECT migration_name FROM public._prisma_migrations WHERE migration_name IN (${names[0]},${names[1]})`
 if(!ours.some(h=>h.migration_name===names[1]))for(const t of NEW_TABLES)assert.equal((await db.$queryRawUnsafe(`SELECT to_regclass('public.${t}')::text AS name`))[0].name,null,'Untracked dispute table requires investigation: '+t)
}
async function verifyStructure(tx){
 const issues=[]
 for(const t of NEW_TABLES){
  const [row]=await tx.$queryRawUnsafe(`SELECT c.relrowsecurity AS rls,(SELECT count(*)::int FROM public."${t}") AS rows FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=$1`,t)
  if(!row)issues.push('missing '+t);else{if(!row.rls)issues.push('RLS off '+t);if(row.rows!==0)issues.push('rows in '+t)}
 }
 const exposed=await tx.$queryRaw`SELECT table_name,grantee,privilege_type FROM information_schema.role_table_grants WHERE table_schema='public' AND table_name=ANY(${NEW_TABLES}) AND grantee IN ('PUBLIC','anon','authenticated','service_role')`
 if(exposed.length)issues.push('exposed '+JSON.stringify(exposed))
 const enums=(await tx.$queryRaw`SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid WHERE t.typname='JournalSourceType' AND e.enumlabel LIKE 'CASH_DISPUTE_%'`).map(r=>r.enumlabel).sort()
 if(enums.join()!=='CASH_DISPUTE_ADJUSTMENT,CASH_DISPUTE_DISPOSITION,CASH_DISPUTE_EFFECT')issues.push('enum '+enums.join())
 const disabled=await tx.$queryRaw`SELECT tgname,tgrelid::regclass::text AS rel FROM pg_trigger WHERE NOT tgisinternal AND tgenabled='D' AND (tgname LIKE '%dispute%' OR tgname LIKE 'protect_cash_%')`
 if(disabled.length)issues.push('disabled triggers '+JSON.stringify(disabled))
 const triggers=(await tx.$queryRaw`SELECT count(*)::int AS n FROM pg_trigger WHERE NOT tgisinternal AND (tgname LIKE '%dispute%')`)[0].n
 const [fn]=await tx.$queryRaw`SELECT to_regprocedure('public.cash_dispute_charge_open(uuid)')::text AS f`
 if(!fn.f)issues.push('missing cash_dispute_charge_open')
 const [balance]=await tx.$queryRaw`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname='cash_settlement_balance'`
 if(!/recoveries/.test(balance?.def||''))issues.push('cash_settlement_balance without recoveries')
 assert.deepEqual(issues,[],'Structure verification failed')
 return {newTables:NEW_TABLES.length,rlsOnAll:true,publicGrants:0,enumValues:enums,disputeTriggers:triggers,chargeOpenFunction:true}
}
async function apply(){
 await preflight()
 const before=await db.$transaction(async tx=>{await tx.$executeRawUnsafe("SET LOCAL TIME ZONE 'UTC'");const admin=await canonical(tx),list=await tables(tx);return {adminRoleId:admin.id,tables:list,projection:await projection(tx,list),permissions:await permissions(tx),grants:await grants(tx)}},{isolationLevel:'RepeatableRead',timeout:300000})
 write('before.json',before)
 const applied=[];for(const [name,sha]of migrations)applied.push(await migrate(name,sha))
 const result=await db.$transaction(async tx=>{
  await tx.$executeRawUnsafe("SET LOCAL lock_timeout='5s'");await tx.$executeRawUnsafe("SET LOCAL statement_timeout='45s'");await tx.$executeRawUnsafe("SET LOCAL TIME ZONE 'UTC'")
  await tx.$executeRawUnsafe('LOCK TABLE public.roles,public.permissions,public.role_permissions IN SHARE ROW EXCLUSIVE MODE')
  const admin=await canonical(tx),p=await permissions(tx),g=await grants(tx),original=before.tables.filter(n=>!['permissions','role_permissions'].includes(n)),data=await projection(tx,original)
  assert.deepEqual(data.map(({table,count,hash})=>({table,count,hash})),before.projection.filter(x=>original.includes(x.table)),'Original tables changed between snapshot and registration')
  await r('./scripts/register-cash-permissions').registerCashDisputePermissionsForAdmin({$transaction:fn=>fn(tx)})
  const after=await permissions(tx),afterGrants=await grants(tx),rows=codes.map(c=>after.find(x=>x.code===c))
  assert.ok(rows.every(Boolean),'Dispute permission missing after registration')
  assert.deepEqual(after.filter(x=>!codes.includes(x.code)),p.filter(x=>!codes.includes(x.code)),'Other permissions changed')
  rows.forEach((row,i)=>{assert.equal(row.name,definitions[i].name);assert.equal(row.description,definitions[i].description)})
  const expected=[...g];for(const row of rows)if(!expected.some(x=>x.role_id===admin.id&&x.permission_id===row.id))expected.push({role_id:admin.id,permission_id:row.id})
  expected.sort((a,b)=>a.role_id-b.role_id||a.permission_id-b.permission_id)
  assert.deepEqual(afterGrants,expected,'Grants other than the five admin grants changed')
  assert.deepEqual(afterGrants.filter(x=>x.role_id!==admin.id),before.grants.filter(x=>x.role_id!==admin.id),'A non-admin grant changed')
  assert.deepEqual(await projection(tx,original),data)
  const structure=await verifyStructure(tx)
  return {adminRoleId:admin.id,permissionIds:rows.map(x=>x.id),addedPermissions:after.length-before.permissions.length,addedAdminGrants:afterGrants.length-before.grants.length,nonAdminGrantsUnchanged:true,
   preservedOriginalTables:original.length,preservedOriginalRows:before.projection.filter(x=>original.includes(x.table)).reduce((n,x)=>n+x.count,0),structure,expectedPermissions:after,expectedGrants:afterGrants}
 },{isolationLevel:'RepeatableRead',timeout:300000,maxWait:10000})
 const fresh=client(process.env.DATABASE_URL)
 try{assert.deepEqual(await permissions(fresh),result.expectedPermissions);assert.deepEqual(await grants(fresh),result.expectedGrants)}finally{await fresh.$disconnect()}
 const {expectedPermissions,expectedGrants,...summary}=result
 write('database-verification.json',{verifiedAt:new Date().toISOString(),rehearsal,identityHash:rehearsal?null:identity,migrations:applied,...summary,runtimeConnectionVerified:true,clientRegenerated:false,apiStarted:false,commandsReleased:false})
 console.log(JSON.stringify({stage:'database-verified',...summary,runtimeConnectionVerified:true}))
}
apply().catch(error=>{console.error(JSON.stringify({stage:'failed',name:error.name,message:/preserv|Untracked|Directed SQL|Explicit approved|differs|pending|Structure|changed|missing|admin/i.test(error.message)?error.message:'Application did not complete; inspect local evidence without exposing connection details'}));process.exitCode=1}).finally(()=>db.$disconnect())
