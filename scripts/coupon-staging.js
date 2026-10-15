const {PrismaClient}=require('@prisma/client')
const {randomUUID,createHash}=require('node:crypto')
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process')
const MIGRATION='202610120001_promotion_coupon_design'
function couponStagingUrl(env=process.env){
  if(env.AUNA_COUPON_STAGING_APPROVAL!=='approved')throw Error('Se requiere aprobación explícita de staging para cupones')
  const url=new URL(env.DIRECT_URL||'invalid')
  if(!['postgres:','postgresql:'].includes(url.protocol)||url.hostname!=='aws-1-us-east-2.pooler.supabase.com'||url.port!=='5432'||url.pathname!=='/postgres')throw Error('Destino de staging no autorizado')
  for(const key of [...url.searchParams.keys()]){if(!['sslmode','connect_timeout','pgbouncer','connection_limit','pool_timeout','schema'].includes(key))throw Error('Opción de conexión no autorizada');url.searchParams.delete(key)}
  url.searchParams.set('connect_timeout','10');return url.toString()
}
const migrationSql=()=>fs.readFileSync(path.join(__dirname,'../prisma/migrations',MIGRATION,'migration.sql'),'utf8')
async function rehearsal(db){
  const schema='coupon_qa_'+randomUUID().replace(/-/g,'')
  try{
    await db.$transaction(async tx=>{
      await tx.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`)
      await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}"`)
      await tx.$executeRawUnsafe('CREATE TABLE companies(id UUID PRIMARY KEY)')
      await tx.$executeRawUnsafe('CREATE TABLE users(id UUID PRIMARY KEY)')
      await tx.$executeRawUnsafe('CREATE TABLE promotions(id UUID PRIMARY KEY, name TEXT)')
      await tx.$executeRawUnsafe("INSERT INTO promotions VALUES ('11111111-1111-4111-8111-111111111111','Promoción intacta')")
      for(const sql of migrationSql().split(';').filter(s=>s.trim()))await tx.$executeRawUnsafe(sql)
      const rows=await tx.$queryRawUnsafe('SELECT name,coupon_design FROM promotions')
      if(rows.length!==1||rows[0].name!=='Promoción intacta'||rows[0].coupon_design!==null)throw Error('La migración alteró datos existentes')
      const columns=await tx.$queryRawUnsafe('SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2',schema,'promotion_coupon_assets')
      if(columns.length!==11)throw Error('Contrato de recursos no coincide con migración')
    },{timeout:30000,maxWait:10000})
  }finally{await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)}
  return true
}
async function deploy(){
  require('../src/config/loadEnv')
  const raw=couponStagingUrl(),url=new URL(raw),db=new PrismaClient({datasources:{db:{url:raw}}})
  try{
    console.log('Staging autorizado: conexión directa verificada')
    await rehearsal(db);console.log('Rehearsal aislado correcto; esquema QA retirado')
    const existing=await db.$queryRaw`SELECT checksum,finished_at FROM public._prisma_migrations WHERE migration_name=${MIGRATION} AND rolled_back_at IS NULL`
    const checksum=createHash('sha256').update(migrationSql()).digest('hex')
    if(existing.length){if(existing[0].checksum!==checksum||!existing[0].finished_at)throw Error('Migración existente incompleta o distinta; no se modificó');console.log('Migración exacta ya aplicada');return}
    const base=path.join(os.homedir(),'.local/share/auna-backups');fs.mkdirSync(base,{recursive:true,mode:0o700})
    const dir=fs.mkdtempSync(path.join(base,'coupons-'));fs.chmodSync(dir,0o700)
    const file=path.join(dir,'staging-public.dump')
    const env={...process.env,PGHOST:url.hostname,PGPORT:url.port,PGDATABASE:'postgres',PGUSER:decodeURIComponent(url.username),PGPASSWORD:decodeURIComponent(url.password),PGSSLMODE:'require',PGCONNECT_TIMEOUT:'15'}
    const dump=spawnSync('pg_dump',['--format=custom','--schema=public','--no-owner','--no-acl','--file',file],{env,timeout:120000})
    if(dump.status!==0)throw Error('No se pudo crear el backup privado; migración no aplicada')
    fs.chmodSync(file,0o600)
    if(fs.statSync(file).size<1000||spawnSync('pg_restore',['--list',file]).status!==0)throw Error('Backup no verificable; migración no aplicada')
    console.log('Backup privado verificado: '+file)
    await db.$transaction(async tx=>{
      await tx.$executeRawUnsafe('LOCK TABLE public.promotions, public.promotion_codes IN SHARE ROW EXCLUSIVE MODE')
      const count=()=>tx.$queryRawUnsafe('SELECT (SELECT count(*)::int FROM public.promotions) AS promotions,(SELECT count(*)::int FROM public.promotion_codes) AS codes,(SELECT coalesce(sum(current_uses),0)::int FROM public.promotion_codes) AS uses')
      const before=await count()
      await tx.$executeRawUnsafe('SET LOCAL search_path TO public')
      for(const sql of migrationSql().split(';').filter(s=>s.trim()))await tx.$executeRawUnsafe(sql)
      const after=await count();if(JSON.stringify(before)!==JSON.stringify(after))throw Error('Conteos cambiaron; migración revertida')
      await tx.$executeRaw`INSERT INTO public._prisma_migrations(id,checksum,migration_name,finished_at,started_at,applied_steps_count) VALUES(${randomUUID()},${checksum},${MIGRATION},NOW(),NOW(),1)`
      console.log('Promociones, códigos y usos intactos: '+JSON.stringify(after[0]))
    },{timeout:30000,maxWait:10000})
    console.log('Aplicada únicamente '+MIGRATION)
  }finally{await db.$disconnect()}
}
if(require.main===module)deploy().catch(()=>{console.error('Despliegue detenido; consulta fase anterior. No se exponen credenciales.');process.exitCode=1})
module.exports={couponStagingUrl,rehearsal}
