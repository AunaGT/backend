const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto')
const {withAppointmentsTestDb}=require('./helpers/appointmentsTestDb.cjs')
const hash=data=>crypto.createHash('sha256').update(data).digest('hex')
async function recordPrerequisites(db,schema){
  await db.$executeRawUnsafe(`CREATE TABLE "${schema}"._prisma_migrations (id VARCHAR(36) PRIMARY KEY,checksum VARCHAR(64) NOT NULL,migration_name VARCHAR(255) NOT NULL,finished_at TIMESTAMPTZ,logs TEXT,rolled_back_at TIMESTAMPTZ,started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),applied_steps_count INTEGER NOT NULL DEFAULT 0)`)
  for(const name of ['202610120002_appointments_core','202610120003_appointments_flexible','202610120004_appointments_unified_services'])await db.$executeRawUnsafe(`INSERT INTO "${schema}"._prisma_migrations (id,checksum,migration_name,finished_at) VALUES ($1::uuid,$2,$3,NOW())`,crypto.randomUUID(),hash(fs.readFileSync(path.join(__dirname,'../prisma/migrations',name,'migration.sql'))),name)
}
test('deploy guard executes the exact commercial delta on prior data while preserving financial and authorization fingerprints',async()=>withAppointmentsTestDb(async({db,scope,schema,fixtures:f})=>{
  const {runCommercialDelta,commercialFingerprint}=require('../scripts/appointments-staging')
  await recordPrerequisites(db,schema)
  await db.$executeRaw`INSERT INTO service_schedule_profiles (id,company_id,product_id,enabled,mode,duration_minutes,instructions,created_by,updated_at) VALUES (${crypto.randomUUID()}::uuid,${scope.companyId}::uuid,${f.productId}::uuid,true,'INDIVIDUAL',45,'Nota previa',${scope.userId}::uuid,NOW())`
  const method=await db.paymentMethod.create({data:{name:'Transferencia histórica QA'}}),status=await db.saleStatus.create({data:{name:'Completada'}})
  const sale={id:crypto.randomUUID()}
  await db.$executeRaw`INSERT INTO sales(id,branch_id,customer_contact_id,total,adjusted_total,items,payment_method_id,status_id,created_by) VALUES (${sale.id}::uuid,${scope.branchId}::uuid,${f.contactId}::uuid,90,90,1,${method.id},${status.id},${scope.userId}::uuid)`
  const payment=await db.customerPayment.create({data:{branch_id:scope.branchId,customer_id:f.contactId,amount:40,payment_method_id:method.id,registered_by:scope.userId},select:{id:true}})
  await db.salePaymentEntry.create({data:{sale_id:sale.id,customer_payment_id:payment.id,amount:40}})
  await db.productStock.create({data:{branch_id:scope.branchId,product_id:f.productId,stock:7}})
  const before=await commercialFingerprint(db,schema)
  const proof=await db.$transaction(tx=>runCommercialDelta(tx,schema),{timeout:60000})
  assert.deepEqual(proof.fingerprints,before)
  assert.equal((await db.serviceScheduleProfile.findUnique({where:{product_id:f.productId}})).completion_policy,'MANUAL')
  assert.equal(await db.appointmentEngagement.count(),0)
  assert.equal((await db.sale.findUnique({where:{id:sale.id}})).adjusted_total.toFixed(2),'90.00')
  assert.equal((await db.customerPayment.findUnique({where:{id:payment.id}})).amount.toFixed(2),'40.00')
  await assert.rejects(()=>db.$executeRaw`UPDATE service_schedule_profiles SET completion_policy='AUTO' WHERE product_id=${f.productId}::uuid`)
},{version:'unified'}))
test('a mismatched prerequisite aborts the delta before changing prior data',async()=>withAppointmentsTestDb(async({db,schema})=>{
  const {runCommercialDelta,commercialFingerprint}=require('../scripts/appointments-staging')
  await recordPrerequisites(db,schema)
  await db.$executeRawUnsafe(`UPDATE "${schema}"._prisma_migrations SET checksum='tampered' WHERE migration_name='202610120004_appointments_unified_services'`)
  const before=await commercialFingerprint(db,schema)
  await assert.rejects(()=>db.$transaction(tx=>runCommercialDelta(tx,schema),{timeout:60000}),/previa/)
  assert.deepEqual(await commercialFingerprint(db,schema),before)
  const columns=await db.$queryRaw`SELECT column_name FROM information_schema.columns WHERE table_schema=${schema} AND table_name='sales' AND column_name='settlement_source'`
  assert.equal(columns.length,0)
},{version:'unified'}))
test('an exact archive restores into an empty local database, proves the delta, then applies once to its approved local source',async()=>{
  const {PrismaClient}=require('@prisma/client'),{execFileSync}=require('node:child_process'),{appointmentsTestUrl}=require('./helpers/appointmentsTestDb.cjs')
  const {createBackup,rehearseRestoredCommercialMigration,applyMigration,commercialFingerprint}=require('../scripts/appointments-staging')
  const base=new URL(appointmentsTestUrl()),suffix=crypto.randomUUID().replaceAll('-',''),sourceName=`agenda_deploy_source_${suffix}`,restoreName=`agenda_deploy_restore_${suffix}`
  base.searchParams.set('sslmode','disable')
  const url=name=>{const result=new URL(base);result.pathname=`/${name}`;return result.toString()}
  const admin=new PrismaClient({datasources:{db:{url:base.toString()}}}),source=new PrismaClient({datasources:{db:{url:url(sourceName)}}}),restore=new PrismaClient({datasources:{db:{url:url(restoreName)}}})
  const schemaBefore=path.resolve(__dirname,'../../deposito-frontend/.superpowers/sdd/2026-10-13-agenda-quotation-payments/schema-before.prisma'),priorEnv={...process.env}
  let createdSource=false,createdRestore=false,receiptPath
  try{
    await admin.$executeRawUnsafe(`CREATE DATABASE "${sourceName}"`);createdSource=true
    await admin.$executeRawUnsafe(`CREATE DATABASE "${restoreName}"`);createdRestore=true
    execFileSync(process.execPath,[require.resolve('prisma/build/index.js'),'db','push','--schema',schemaBefore,'--skip-generate'],{cwd:path.resolve(__dirname,'..'),env:{...process.env,DATABASE_URL:url(sourceName),DIRECT_URL:url(sourceName)},stdio:'pipe',timeout:60000})
    await recordPrerequisites(source,'public')
    // db push cannot express PostgreSQL CHECKs; retain the actual prerequisite's request constraint in this baseline.
    await source.$executeRawUnsafe(`ALTER TABLE appointment_requests ADD CONSTRAINT appointment_request_result_check CHECK (result_type IN ('BOOKING','SESSION','WAITLIST','ACTIVITY') AND input_hash ~ '^[0-9a-f]{64}$')`)
    await source.company.create({data:{name:'Preservación local QA',code:suffix.slice(0,10)},select:{id:true}})
    const before=await commercialFingerprint(source)
    receiptPath=createBackup(url(sourceName),'commercial')
    const proof=await rehearseRestoredCommercialMigration(url(sourceName),receiptPath,url(restoreName))
    assert.equal(proof.checks.length,4);assert.deepEqual(await commercialFingerprint(source),before)
    await assert.rejects(()=>rehearseRestoredCommercialMigration(url(sourceName),receiptPath,url(restoreName)),/no está vacía/)
    await assert.rejects(()=>applyMigration(url(sourceName),receiptPath,'commercial'),/aprobación/)
    process.env.AUNA_APPOINTMENTS_STAGING_APPROVAL='approved';process.env.AUNA_APPOINTMENTS_COMMERCIAL_APPROVAL='approved';process.env.APPOINTMENTS_CONFIRM_HOST=new URL(url(sourceName)).host;process.env.APPOINTMENTS_CONFIRM_DATABASE=sourceName
    const result=await applyMigration(url(sourceName),receiptPath,'commercial');assert.equal(result.historyPreserved,true);assert.deepEqual(await commercialFingerprint(source),before)
    assert.equal(await applyMigration(url(sourceName),receiptPath,'commercial'),'Ya aplicada con el mismo checksum')
    const applied=await source.$queryRaw`SELECT count(*)::int AS count FROM _prisma_migrations WHERE migration_name='202610130001_appointments_commercial'`;assert.equal(applied[0].count,1)
  }finally{
    for(const key of Object.keys(process.env))if(!Object.hasOwn(priorEnv,key))delete process.env[key]
    Object.assign(process.env,priorEnv)
    await source.$disconnect();await restore.$disconnect()
    try{if(createdSource)await admin.$executeRawUnsafe(`DROP DATABASE "${sourceName}"`);if(createdRestore)await admin.$executeRawUnsafe(`DROP DATABASE "${restoreName}"`)}finally{await admin.$disconnect()}
    if(receiptPath)console.log('Private local QA backup retained:',receiptPath)
  }
})
