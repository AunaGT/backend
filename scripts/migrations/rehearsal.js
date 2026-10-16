const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{randomUUID}=require('node:crypto')
const {captureInventory,compareInventory,captureRows,hash,identifier,canonical}=require('./inventory')
const {compileRehearsal,assertQaSchema,tokens,statements}=require('./baselineSql')
const root=path.resolve(__dirname,'../..'),baseline='0_auna_baseline_20261015',payment='202610150002_company_payment_methods'
const fail=(code,message=code)=>{throw Object.assign(new Error(message),{code})}
function artifacts(receipt,receiptHash){
  const dir=path.join(root,'prisma/migrations',baseline),manifest=JSON.parse(fs.readFileSync(path.join(dir,'manifest.json')))
  const archiveFile=path.join(root,'prisma/migrations-archive/pre-baseline-20261015/manifest.json'),archive=JSON.parse(fs.readFileSync(archiveFile))
  const old=receipt.local.filter(m=>m.name!==payment)
  if(manifest.sourceReceiptHash!==receiptHash||hash(fs.readFileSync(archiveFile))!==manifest.archiveManifestChecksum||JSON.stringify(old)!==JSON.stringify(archive.migrations)||hash(JSON.stringify(canonical(manifest.inventory)))!==hash(JSON.stringify(canonical(receipt.inventory))))fail('BASELINE_ARTIFACT_CHANGED')
  for(const m of old)if(hash(fs.readFileSync(require('../migrationFiles').migrationSqlPath(m.name,{historical:true})))!==m.checksum)fail('BASELINE_ARTIFACT_CHANGED')
  const baselineSql=fs.readFileSync(path.join(dir,'migration.sql'),'utf8'),paymentSql=fs.readFileSync(path.join(root,'prisma/migrations',payment,'migration.sql'),'utf8')
  if(hash(baselineSql)!==manifest.checksum||hash(paymentSql)!==receipt.local.find(m=>m.name===payment)?.checksum)fail('BASELINE_ARTIFACT_CHANGED')
  const active=fs.readdirSync(path.join(root,'prisma/migrations'),{withFileTypes:true}).filter(d=>d.isDirectory()).map(d=>d.name).sort()
  if(JSON.stringify(active)!==JSON.stringify([baseline,payment]))fail('BASELINE_ARTIFACT_CHANGED')
  return {baselineSql,paymentSql,manifest}
}
async function cleanupRehearsal(db,run){
  assertQaSchema(run.schema)
  const ns=await db.$queryRawUnsafe('SELECT oid::text AS oid FROM pg_namespace WHERE nspname=$1',run.schema)
  if(ns.length!==1||ns[0].oid!==run.oid)fail('BASELINE_QA_CLEANUP_REFUSED')
  const objects=await db.$queryRawUnsafe("SELECT relname AS name FROM pg_class WHERE relnamespace=$1::oid UNION SELECT proname FROM pg_proc WHERE pronamespace=$1::oid UNION SELECT typname FROM pg_type WHERE typnamespace=$1::oid AND typrelid=0",run.oid)
  if(objects.some(o=>!run.allowed.includes(o.name)))fail('BASELINE_QA_CLEANUP_REFUSED')
  await db.$executeRawUnsafe(`DROP SCHEMA ${identifier(run.schema)} CASCADE`)
  if((await db.$queryRawUnsafe('SELECT oid::text FROM pg_namespace WHERE nspname=$1',run.schema)).length)fail('BASELINE_QA_CLEANUP_REFUSED')
}
function allowedObjects(inventory,paymentSql){
  const names=new Set(['_prisma_migrations','_prisma_migrations_pkey'])
  for(const key of ['tables','sequences','indexes','functions','types'])for(const o of inventory[key])names.add(o.name)
  for(const m of paymentSql.matchAll(/CREATE (?:OR REPLACE )?(?:UNIQUE )?(?:TABLE|TYPE|FUNCTION|INDEX|TRIGGER)\s+"?([A-Za-z_0-9]+)"?/gi))names.add(m[1])
  for(const name of ['company_payment_methods_pkey','company_payment_methods_position_check','payment_methods_company_id_name_key'])names.add(name)
  for(const o of [...names])names.add('_'+o)
  return [...names]
}
async function assertSource(db,r){
  await db.$transaction(async tx=>{
    await tx.$executeRawUnsafe("SET LOCAL TIME ZONE 'UTC'")
    await tx.$executeRawUnsafe('SET LOCAL search_path=pg_catalog')
    const differences=compareInventory(await captureInventory(tx,'public'),r.inventory)
    if(differences.length)fail('BASELINE_SOURCE_CHANGED',`Source catalog changed: ${differences.join(',')}`)
    if(JSON.stringify(await captureRows(tx,'public',r.projections))!==JSON.stringify(r.rows))fail('BASELINE_SOURCE_CHANGED','Source business rows changed')
  },{timeout:180000,maxWait:15000})
}
function assertPaymentCatalog(after,inventory,paymentSql,schema){
  for(const name of ['payment_method_kind_consistent','payment_method_private_kind','company_payment_methods_position_check'])
    if(!after.constraints.some(c=>c.name===name))fail('BASELINE_QA_MISMATCH',`Missing payment constraint: ${name}`)
  for(const name of ['payment_methods_shared_name_key','payment_methods_private_normalized_name_key','payment_methods_base_code_key'])
    if(!after.indexes.some(i=>i.name===name&&i.valid))fail('BASELINE_QA_MISMATCH',`Missing payment index: ${name}`)
  const body=sql=>tokens(tokens(sql).find(t=>t.kind==='body').value).filter(t=>!['space','comment'].includes(t.kind)).map(t=>t.kind==='word'?t.text.toLowerCase():t.text).join(' ')
  for(const stmt of statements(paymentSql).filter(s=>/^CREATE (?:OR REPLACE )?FUNCTION/i.test(s))){
    const name=stmt.match(/^CREATE (?:OR REPLACE )?FUNCTION\s+(\w+)/i)[1],actual=after.functions.find(f=>f.name===name)
    if(!actual||body(actual.definition)!==body(stmt))fail('BASELINE_QA_MISMATCH',`Payment function differs: ${name}`)
  }
  for(const f of inventory.functions.filter(f=>f.name!=='guard_confirmed_sale_payment_method'))
    if(compareInventory({functions:after.functions.filter(o=>o.name===f.name)},{functions:[f]},{targetSchema:schema}).length)fail('BASELINE_QA_MISMATCH',`Historical function changed: ${f.name}`)
}
async function runRehearsal({env=process.env,receiptPath,open}={}){
  if(env.AUNA_BASELINE_DEV!=='1')fail('BASELINE_OPT_IN_REQUIRED')
  const cli=require('../reconcile-migrations'),r=cli.readReceipt(receiptPath),url=env.DIRECT_URL
  cli.assertTarget(url,r,env)
  cli.verifyReceipt(r,r.identity,()=>require('node:child_process').execFileSync('pg_restore',['--list',r.backup.file],{encoding:'utf8',timeout:30000}))
  const a=artifacts(r,hash(fs.readFileSync(receiptPath))),schema='auna_baseline_qa_'+randomUUID().replaceAll('-','')
  const baselineSql=compileRehearsal(a.baselineSql,{schema,inventory:r.inventory,artifactChecksum:a.manifest.checksum})
  const paymentSql=compileRehearsal(a.paymentSql,{schema,inventory:r.inventory,artifactChecksum:hash(a.paymentSql)})
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'auna-baseline-rehearsal-'));fs.chmodSync(dir,0o700)
  const qaUrl=new URL(url);qaUrl.searchParams.set('schema',schema)
  const privateEnv={...env,DATABASE_URL:qaUrl.toString(),DIRECT_URL:qaUrl.toString()}
  cli.savePrivate(path.join(dir,'schema.prisma'),'datasource db {\n provider="postgresql"\n url=env("DATABASE_URL")\n directUrl=env("DIRECT_URL")\n}\n')
  fs.mkdirSync(path.join(dir,'migrations',baseline),{recursive:true})
  cli.savePrivate(path.join(dir,'migrations',baseline,'migration.sql'),baselineSql)
  cli.savePrivate(path.join(dir,'migrations','migration_lock.toml'),'provider = "postgresql"\n')
  const db=open?await open(url):new (require('@prisma/client').PrismaClient)({datasources:{db:{url}}})
  const run={schema,allowed:allowedObjects(r.inventory,a.paymentSql),sourceReceiptHash:hash(fs.readFileSync(receiptPath)),baselineChecksum:a.manifest.checksum,paymentChecksum:hash(a.paymentSql),installation:false,historyRecovery:false,qaCleaned:false}
  let created=false
  const deploy=()=>cli.child(process.execPath,[require.resolve('prisma/build/index.js'),'migrate','deploy','--schema',path.join(dir,'schema.prisma')],privateEnv)
  try{
    await assertSource(db,r)
    cli.savePrivate(path.join(dir,'planned.json'),run)
    await db.$executeRawUnsafe(`CREATE SCHEMA ${identifier(schema)}`);created=true
    run.oid=(await db.$queryRawUnsafe('SELECT oid::text AS oid FROM pg_namespace WHERE nspname=$1',schema))[0].oid
    await db.$executeRawUnsafe(`REVOKE ALL ON SCHEMA ${identifier(schema)} FROM PUBLIC,anon,authenticated,service_role`)
    cli.savePrivate(path.join(dir,'run.json'),run)
    await deploy()
    const actual=await db.$transaction(async tx=>{await tx.$executeRawUnsafe('SET LOCAL search_path=pg_catalog');return captureInventory(tx,schema)},{timeout:60000,maxWait:15000})
    const diffs=compareInventory(actual,r.inventory,{targetSchema:schema,exclude:['grants','functionGrants','publications']})
    if(diffs.length){cli.savePrivate(path.join(dir,'catalog-mismatch.json'),{diffs,actual});fail('BASELINE_QA_MISMATCH',`Rebuilt catalog differs: ${diffs.join(',')}`)}
    fs.mkdirSync(path.join(dir,'migrations',payment))
    cli.savePrivate(path.join(dir,'migrations',payment,'migration.sql'),paymentSql)
    await deploy()
    const after=await db.$transaction(async tx=>{await tx.$executeRawUnsafe('SET LOCAL search_path=pg_catalog');return captureInventory(tx,schema)},{timeout:60000,maxWait:15000})
    assertPaymentCatalog(after,r.inventory,a.paymentSql,schema)
    const oldTables=r.inventory.tables.map(o=>o.name)
    if(after.tables.length!==oldTables.length+1||!after.tables.some(o=>o.name==='company_payment_methods'))fail('BASELINE_QA_MISMATCH')
    for(const c of r.inventory.constraints)if(!after.constraints.some(o=>o.table===c.table&&o.name===c.name&&compareInventory({constraints:[o]},{constraints:[c]},{targetSchema:schema}).length===0))fail('BASELINE_QA_MISMATCH',`Constraint changed: ${c.name}`)
    const beforeSecond=await db.$queryRawUnsafe(`SELECT row_to_json(m)::text AS row FROM ${identifier(schema)}._prisma_migrations m ORDER BY id`)
    await deploy()
    if(JSON.stringify(beforeSecond)!==JSON.stringify(await db.$queryRawUnsafe(`SELECT row_to_json(m)::text AS row FROM ${identifier(schema)}._prisma_migrations m ORDER BY id`)))fail('BASELINE_QA_REPLAY_CHANGED')
    const fixture=fs.readFileSync(path.join(root,'tests/fixtures/baseline-probes.sql'),'utf8')
    await cli.child('psql',['-X','--no-password','--set','ON_ERROR_STOP=1'],cli.postgresEnv(url,env),{input:`SET search_path=${identifier(schema)},pg_catalog,extensions;\n`+fixture})
    await assertSource(db,r)
    run.installation=true
  }finally{
    try{if(created){await cleanupRehearsal(db,run);run.qaCleaned=true}cli.savePrivate(path.join(dir,'result.json'),run)}finally{await db.$disconnect()}
  }
  return {receipt:path.join(dir,'result.json'),...run}
}
module.exports={runRehearsal,cleanupRehearsal,artifacts,assertSource,allowedObjects,baseline,payment}
