const fs=require('node:fs'),path=require('node:path'),os=require('node:os')
const {randomUUID}=require('node:crypto'),{spawn}=require('node:child_process')
const {connectionIdentity,assertDevTarget}=require('./salesDevTarget')
const {sanitizeDiagnostic}=require('./sales-drafts-deploy')
const {captureInventory,captureRows,fingerprintRows,hash}=require('./migrations/inventory')
const root=path.resolve(__dirname,'..')
function postgresEnv(rawUrl,baseEnv=process.env){const u=new URL(rawUrl);return {...baseEnv,PGHOST:u.hostname,PGPORT:u.port||'5432',PGUSER:decodeURIComponent(u.username),PGPASSWORD:decodeURIComponent(u.password),PGDATABASE:decodeURIComponent(u.pathname.slice(1)),PGSSLMODE:'require',PGCONNECT_TIMEOUT:'15'}}
function child(binary,args,env=process.env,{input,timeout=120000,signal}={}){
  return new Promise((resolve,reject)=>{
    if(signal?.aborted){reject(signal.reason||new Error('Child aborted'));return}
    const grouped=process.platform!=='win32'
    const p=spawn(binary,args,{cwd:root,env,stdio:['pipe','pipe','pipe'],detached:grouped});let out='',err='',settled=false,cancelError,killTimer
    const kill=kind=>{try{grouped?process.kill(-p.pid,kind):p.kill(kind)}catch(error){if(error.code!=='ESRCH')p.kill(kind)}}
    function cancel(error){if(cancelError)return;cancelError=error;kill('SIGTERM');killTimer=setTimeout(()=>kill('SIGKILL'),1000)}
    const timer=setTimeout(()=>cancel(new Error(`${binary} timeout`)),timeout)
    const aborted=()=>cancel(signal.reason||new Error('Child aborted'))
    signal?.addEventListener('abort',aborted,{once:true})
    function finish(error){if(settled)return;settled=true;clearTimeout(timer);clearTimeout(killTimer);signal?.removeEventListener('abort',aborted);error?reject(error):resolve(out)}
    p.stdout.on('data',b=>{out+=b;if(out.length>32*1024*1024)cancel(new Error('Child output limit'))})
    p.stderr.on('data',b=>{err=(err+b).slice(-20000)})
    p.on('error',finish);p.on('close',code=>finish(cancelError||(code===0?null:Object.assign(new Error(sanitizeDiagnostic(`${binary} failed (${code}): ${err}`,env)),{exitCode:code,stdout:sanitizeDiagnostic(out,env)}))))
    p.stdin.on('error',()=>{});p.stdin.end(input)
  })
}
function assertTarget(url,receipt,env=process.env){
  assertDevTarget({connectionUrl:url,approvedHost:receipt.target.host,approvedDatabase:receipt.target.database,approvedIdentity:receipt.identity,approved:env.AUNA_BASELINE_DEV==='1'})
  if((new URL(url).port||'5432')!==receipt.target.directPort)throw Error('Development port mismatch')
}
function verifyReceipt(receipt,identity,list){
  if(receipt.formatVersion!==1||receipt.identity!==identity)throw Error('Backup identity mismatch')
  const file=receipt.backup.file
  if(fs.lstatSync(file).isSymbolicLink()||hash(fs.readFileSync(file))!==receipt.backup.checksum)throw Error('Backup checksum mismatch')
  const listing=list(file)
  for(const name of [...receipt.inventory.tables.map(t=>t.name),'_prisma_migrations'])
    if(!listing.includes(`TABLE DATA public ${name} `))throw Error(`Backup incomplete: ${name}`)
  return receipt
}
function savePrivate(file,value){fs.writeFileSync(file,typeof value==='string'?value:JSON.stringify(value,null,2),{mode:0o600,flag:'wx'})}
function readReceipt(file){
  if(!path.isAbsolute(file)||fs.lstatSync(file).isSymbolicLink())throw Error('Absolute private receipt required')
  const r=JSON.parse(fs.readFileSync(file,'utf8'));r.receiptPath=file;return r
}
function localMigrations(){return fs.readdirSync(path.join(root,'prisma/migrations'),{withFileTypes:true}).filter(d=>d.isDirectory()).map(d=>({name:d.name,checksum:hash(fs.readFileSync(path.join(root,'prisma/migrations',d.name,'migration.sql')))})).sort((a,b)=>a.name.localeCompare(b.name))}
async function capture(db,url){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'auna-baseline-private-'));fs.chmodSync(dir,0o700)
  const file=path.join(dir,'public.dump'),schemaFile=path.join(dir,'schema.sql'),receiptFile=path.join(dir,'receipt.json')
  const env=postgresEnv(url),u=new URL(url)
  const r=await db.$transaction(async tx=>{
    await tx.$executeRawUnsafe('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await tx.$executeRawUnsafe("SET LOCAL TIME ZONE 'UTC'")
    await tx.$executeRawUnsafe('SET LOCAL search_path=pg_catalog')
    const [{snapshot}]=await tx.$queryRawUnsafe('SELECT pg_export_snapshot() AS snapshot')
    const inventory=await captureInventory(tx,'public')
    const projections=Object.fromEntries(inventory.tables.map(t=>[t.name,inventory.columns.filter(c=>c.table===t.name).map(c=>c.name)]))
    const rows=await captureRows(tx,'public',projections)
    const history=await tx.$queryRawUnsafe('SELECT row_to_json(m)::text AS row FROM public._prisma_migrations m ORDER BY id')
    const [{oid}]=await tx.$queryRawUnsafe("SELECT 'public._prisma_migrations'::regclass::oid::text AS oid")
    const local=localMigrations(),records=history.map(r=>JSON.parse(r.row)),active=records.filter(r=>!r.rolled_back_at)
    if(active.some(r=>!r.finished_at))throw Error('Unresolved failed migration')
    if(active.some(r=>local.some(m=>m.name===r.migration_name&&m.checksum!==r.checksum)))throw Error('Migration checksum mismatch')
    const pending=local.filter(m=>!active.some(r=>r.migration_name===m.name)).map(m=>m.name)
    if(JSON.stringify(pending)!==JSON.stringify(['202610150002_company_payment_methods']))throw Error('Unexpected pending migrations')
    await child('pg_dump',['--format=custom','--schema=public','--no-owner','--no-acl',`--snapshot=${snapshot}`,'--file',file],env)
    fs.chmodSync(file,0o600)
    const sql=await child('pg_dump',['--schema-only','--schema=public','--no-owner','--no-acl','--exclude-table=public._prisma_migrations','--no-publications','--no-subscriptions',`--snapshot=${snapshot}`],env)
    savePrivate(schemaFile,sql)
    return {formatVersion:1,runId:randomUUID(),identity:connectionIdentity(url),target:{host:u.hostname,database:decodeURIComponent(u.pathname.slice(1)),directPort:u.port||'5432'},createdAt:new Date().toISOString(),historyOid:oid,historyHash:fingerprintRows(history.map(r=>r.row)),history:records,inventory,projections,rows,local,pending,schemaFile,schemaChecksum:hash(sql),backup:{file,checksum:hash(fs.readFileSync(file))}}
  },{timeout:180000,maxWait:15000})
  const listing=await child('pg_restore',['--list',file])
  verifyReceipt(r,r.identity,()=>listing);savePrivate(receiptFile,r)
  return receiptFile
}
async function main(){
  require('../src/config/loadEnv')
  const url=process.env.DIRECT_URL,u=new URL(url)
  if(!['postgres:','postgresql:'].includes(u.protocol)||(u.port||'5432')!=='5432'||(u.searchParams.get('schema')||'public')!=='public')throw Error('Current direct public connection required')
  if(process.env.DATABASE_URL&&connectionIdentity(process.env.DATABASE_URL)!==connectionIdentity(url))throw Error('API and direct project mismatch')
  const mode=process.argv[2],receiptPath=process.argv[process.argv.indexOf('--receipt')+1]
  const {PrismaClient}=require('@prisma/client'),db=new PrismaClient({datasources:{db:{url}}})
  try{
    if(mode==='capture')console.log(JSON.stringify({receipt:await capture(db,url)}))
    else if(mode==='inspect'){
      const r=readReceipt(receiptPath),listing=await child('pg_restore',['--list',r.backup.file])
      verifyReceipt(r,connectionIdentity(url),()=>listing)
      const {artifacts}=require('./migrations/rehearsal'),a=artifacts(r,hash(fs.readFileSync(receiptPath)))
      const phase=await require('./migrations/history').inspectHistory(db,{...r,baselineChecksum:a.manifest.checksum,paymentChecksum:hash(a.paymentSql)})
      console.log(JSON.stringify({backupVerified:true,identity:r.identity,tables:r.inventory.tables.length,phase,pendingAtCapture:r.pending}))
    }else if(mode==='prepare'){
      const r=readReceipt(receiptPath),listing=await child('pg_restore',['--list',r.backup.file]);verifyReceipt(r,connectionIdentity(url),()=>listing)
      const dump=fs.readFileSync(r.schemaFile,'utf8');if(hash(dump)!==r.schemaChecksum)throw Error('Source schema checksum mismatch')
      const candidate=require('./migrations/baselineSql').compileBaseline(dump,r.inventory)
      const dir=path.dirname(receiptPath),sqlFile=path.join(dir,'baseline.sql'),manifestFile=path.join(dir,'candidate.json')
      savePrivate(sqlFile,candidate.sql);savePrivate(manifestFile,{sourceReceiptHash:hash(fs.readFileSync(receiptPath)),sqlFile,checksum:candidate.checksum,inventory:r.inventory})
      console.log(JSON.stringify({candidate:manifestFile,bytes:Buffer.byteLength(candidate.sql),checksum:candidate.checksum}))
    }else if(mode==='rehearse'){
      console.log(JSON.stringify(await require('./migrations/rehearsal').runRehearsal({receiptPath})))
    }else if(['promote-history','apply-payments','recover-history'].includes(mode)){
      const rehearsalPath=process.argv[process.argv.indexOf('--rehearsal')+1]
      console.log(JSON.stringify(await require('./migrations/promotion').runPromotion({mode,receiptPath,rehearsalPath})))
    }else throw Error('Choose capture, prepare, rehearse or inspect')
  }finally{await db.$disconnect()}
}
if(require.main===module)main().catch(e=>{console.error(sanitizeDiagnostic(e.message));process.exitCode=1})
module.exports={verifyReceipt,assertTarget,postgresEnv,child,savePrivate,readReceipt,capture,localMigrations,main}
