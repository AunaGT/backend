const fs=require('node:fs'),path=require('node:path'),os=require('node:os')
const {createHash}=require('node:crypto'),{spawnSync}=require('node:child_process')
const {approvedDevTarget,connectionIdentity}=require('./salesDevTarget')
const root=path.resolve(__dirname,'..'),migrationName='202610140001_sales_drafts_and_external_invoices'
const checksum=value=>createHash('sha256').update(value).digest('hex')
function migrationPlan(local,history){
  if(local.some(m=>!m.checksum))throw Error('Missing migration file requires review')
  const active=history.filter(m=>!m.rolled_back_at)
  if(active.some(m=>!m.finished_at))throw Error('Failed migration requires review')
  // Archived migrations remain historical evidence, never pending work to replay.
  for(const m of active){const file=local.find(l=>l.name===m.migration_name);if(file&&file.checksum!==m.checksum)throw Error(`Migration checksum mismatch: ${m.migration_name}`)}
  const pending=local.filter(l=>!active.some(m=>m.migration_name===l.name)).map(l=>l.name)
  if(pending.some(n=>![migrationName,'202610140002_sales_history_access'].includes(n)))throw Error('Unexpected pending migrations require review')
  return pending
}
function pgEnv(url){const u=new URL(url);return {...process.env,PGHOST:u.hostname,PGPORT:u.port||'5432',PGUSER:decodeURIComponent(u.username),PGPASSWORD:decodeURIComponent(u.password),PGDATABASE:decodeURIComponent(u.pathname.slice(1)),PGSSLMODE:'require',PGCONNECT_TIMEOUT:'15'}}
function sanitizeDiagnostic(output,env=process.env){
  let text=String(output).replace(/postgres(?:ql)?:\/\/[^\s]+/g,'[connection]')
  for(const key of ['DATABASE_URL','DIRECT_URL'])if(env[key]){
    const password=new URL(env[key]).password
    if(password)for(const value of new Set([password,decodeURIComponent(password)]))text=text.split(value).join('[redacted]')
  }
  return text
}
function child(binary,args,env){
  const r=spawnSync(binary,args,{env,cwd:root,encoding:'utf8',maxBuffer:16*1024*1024})
  if(r.error||r.status!==0)throw Error(`${binary} failed: ${sanitizeDiagnostic((r.stdout||'')+'\n'+(r.stderr||r.error?.message||''),env)}`)
  return r.stdout
}
function verifyBackup(manifestPath,identity){
  const manifest=JSON.parse(fs.readFileSync(manifestPath,'utf8'))
  if(manifest.identity!==identity)throw Error('Backup project identity mismatch')
  if(!manifest.file||checksum(fs.readFileSync(manifest.file))!==manifest.checksum)throw Error('Backup checksum mismatch')
  const listing=child('pg_restore',['--list',manifest.file],process.env)
  if(!/TABLE DATA public sales /.test(listing)||!/TABLE DATA public appointment_engagements /.test(listing))throw Error('Backup lacks required application data')
  return manifest
}
async function main(){
  require('../src/config/loadEnv')
  const url=process.env.DIRECT_URL,target=approvedDevTarget(url),identity=connectionIdentity(url)
  approvedDevTarget(process.env.DATABASE_URL)
  const {PrismaClient}=require('@prisma/client'),db=new PrismaClient({datasources:{db:{url}}})
  try{
    const mode=process.argv[2]
    if(!['--preflight','--backup','--deploy','--verify'].includes(mode))throw Error('Choose --preflight, --backup, --deploy or --verify')
    const folder=path.join(root,'prisma/migrations')
    const local=fs.readdirSync(folder,{withFileTypes:true}).filter(entry=>entry.isDirectory()).map(entry=>entry.name).sort().map(name=>({name,checksum:fs.existsSync(path.join(folder,name,'migration.sql'))?checksum(fs.readFileSync(path.join(folder,name,'migration.sql'))):null}))
    const history=await db.$queryRaw`SELECT migration_name,checksum,finished_at,rolled_back_at FROM _prisma_migrations`
    const pending=migrationPlan(local,history)
    const invalid=await db.sale.count({where:{status:{name:'Completada'},payment_method_id:null}})
    if(invalid)throw Error('Historical confirmed sales have no payment method')
    const duplicates=await db.$queryRaw`SELECT b.company_id FROM sale_dtes d JOIN sales s ON s.id=d.sale_id JOIN branches b ON b.id=s.branch_id WHERE nullif(btrim(d.authorization),'') IS NOT NULL GROUP BY b.company_id,lower(btrim(d.authorization)) HAVING count(*)>1`
    if(duplicates.length)throw Error('Duplicate historical fiscal authorizations require review')
    console.log(JSON.stringify({target,pending,historicalStatuses:await db.saleStatus.findMany({select:{name:true}})}))
    if(mode==='--backup'){
      const dir=fs.mkdtempSync(path.join(os.tmpdir(),'auna-sales-backup-'));fs.chmodSync(dir,0o700)
      const file=path.join(dir,'public.dump'),manifestPath=path.join(dir,'manifest.json')
      child('pg_dump',['--format=custom','--schema=public','--no-owner','--no-acl','--file',file],pgEnv(url));fs.chmodSync(file,0o600)
      fs.writeFileSync(manifestPath,JSON.stringify({identity,file,checksum:checksum(fs.readFileSync(file)),createdAt:new Date().toISOString(),scope:'public application schema and data'}),{mode:0o600})
      verifyBackup(manifestPath,identity)
      console.log(JSON.stringify({verifiedBackupManifest:manifestPath}))
    }
    if(mode==='--deploy'){
      if(!process.env.AUNA_DEV_BACKUP_MANIFEST)throw Error('Verified backup manifest required')
      verifyBackup(process.env.AUNA_DEV_BACKUP_MANIFEST,identity)
      if(pending.length)console.log(child(process.execPath,[path.join(root,'scripts/prisma-cli.js'),'migrate','deploy'],process.env))
      console.log('Additive migration deployment completed')
    }
    if(mode==='--verify'){
      if(pending.length)throw Error('Migration still pending')
      const rows=await db.$queryRaw`SELECT count(*)::int AS invalid FROM appointment_engagements e LEFT JOIN sales s ON s.id=e.sale_id WHERE e.sale_id IS NOT NULL AND (s.origin_engagement_id IS DISTINCT FROM e.id OR s.branch_id<>e.branch_id)`
      if(rows[0].invalid)throw Error('Historical engagement origin mismatch')
      console.log('Historical sale origins verified')
    }
  }finally{await db.$disconnect()}
}
if(require.main===module)main().catch(e=>{console.error(e.code?`Deployment stopped: ${e.code}`:e.message);process.exitCode=1})
module.exports={migrationPlan,verifyBackup,sanitizeDiagnostic}
