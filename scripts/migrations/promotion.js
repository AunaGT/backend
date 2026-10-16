const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process')
const {hash}=require('./inventory')
const {artifacts,assertSource,baseline,payment}=require('./rehearsal')
const history=require('./history')
const root=path.resolve(__dirname,'../..'),fail=code=>{throw Object.assign(new Error(code),{code})}
async function quiet(db,gatePid){
  if(execFileSync('ss',['-ltnH','( sport = :3000 or sport = :8080 )'],{encoding:'utf8',timeout:10000}).trim())fail('BASELINE_AUNA_RUNNING')
  await history.assertNoWriters(db,gatePid)
}
async function verifyOriginalRows(db,r){
  await db.$transaction(async tx=>{
    await tx.$executeRawUnsafe("SET LOCAL TIME ZONE 'UTC'")
    const {captureRows}=require('./inventory'),rows=await captureRows(tx,'public',r.projections)
    if(JSON.stringify(rows)!==JSON.stringify(r.rows))fail('BASELINE_BUSINESS_CHANGED')
  },{timeout:180000,maxWait:15000})
}
async function runPromotion({mode,receiptPath,rehearsalPath,env=process.env}={}){
  if(env.AUNA_BASELINE_DEV!=='1')fail('BASELINE_OPT_IN_REQUIRED')
  if(!['promote-history','apply-payments','recover-history'].includes(mode))fail('BASELINE_MODE_INVALID')
  const cli=require('../reconcile-migrations'),r=cli.readReceipt(receiptPath),url=env.DIRECT_URL
  cli.assertTarget(url,r,env)
  cli.verifyReceipt(r,r.identity,()=>execFileSync('pg_restore',['--list',r.backup.file],{encoding:'utf8',timeout:30000}))
  const a=artifacts(r,hash(fs.readFileSync(receiptPath))),sourceReceiptHash=hash(fs.readFileSync(receiptPath))
  const state={...r,baselineChecksum:a.manifest.checksum,paymentChecksum:hash(a.paymentSql)}
  const rehearsal=JSON.parse(fs.readFileSync(rehearsalPath,'utf8'))
  history.validateRehearsal(rehearsal,{sourceReceiptHash,baselineChecksum:state.baselineChecksum,paymentChecksum:state.paymentChecksum})
  const head=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim()
  if(head!==env.AUNA_BASELINE_REVIEW_HEAD||execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim())fail('BASELINE_REVIEW_REQUIRED')
  const {PrismaClient}=require('@prisma/client'),db=new PrismaClient({datasources:{db:{url}}}),gateDb=new PrismaClient({datasources:{db:{url}}})
  const privateDir=path.dirname(receiptPath),journal=path.join(privateDir,'promotion-events.jsonl')
  const record=phase=>fs.appendFileSync(journal,JSON.stringify({phase,at:new Date().toISOString(),head,sourceReceiptHash})+'\n',{mode:0o600})
  const native=(args,signal)=>cli.child(process.execPath,[path.join(root,'scripts/prisma-cli.js'),...args],env,{signal})
  try{
    return await history.withMigrationGate(gateDb,async gate=>{
      await quiet(db,gate.pid);await gate.check()
      let phase=await history.inspectHistory(db,state)
      record(phase)
      if(mode==='promote-history'){
        if(phase==='PAYMENTS_APPLIED')return {phase,unchanged:true}
        await assertSource(db,r);await quiet(db,gate.pid);await gate.check()
        await history.archiveHistory(db,state)
        phase=await history.inspectHistory(db,state);record(phase)
        if(phase==='ARCHIVED'){
          await gate.check();await native(['migrate','resolve','--applied',baseline],gate.signal)
          phase=await history.inspectHistory(db,state);record(phase)
        }
        if(phase!=='BASELINED')fail('BASELINE_HISTORY_REVIEW_REQUIRED')
        try{await gate.check();await native(['migrate','status'],gate.signal);fail('BASELINE_INTERMEDIATE_STATUS_INVALID')}
        catch(error){
          if(error.exitCode!==1||!error.stdout?.includes(payment)||/diverg|failed migration|not found locally|not applied to the database.*baseline/is.test(error.stdout))throw error
          if(await history.inspectHistory(db,state)!=='BASELINED')fail('BASELINE_HISTORY_REVIEW_REQUIRED')
        }
        await verifyOriginalRows(db,r)
      }else if(mode==='apply-payments'){
        if(phase==='BASELINED')await assertSource(db,r)
        await quiet(db,gate.pid);await gate.check()
        await history.applyPaymentCommands(db,state,gate,native)
        phase=await history.inspectHistory(db,state);record(phase)
        await verifyOriginalRows(db,r)
        const preferences=await db.$queryRawUnsafe('SELECT count(*)::int AS count FROM public.company_payment_methods')
        const basics=await db.$queryRawUnsafe('SELECT base_code,settlement_kind::text FROM public.payment_methods WHERE base_code IS NOT NULL ORDER BY base_code')
        if(basics.length!==4||preferences[0].count===0)fail('BASELINE_PAYMENT_VERIFICATION_FAILED')
      }else if(mode==='recover-history'){
        await gate.check();await history.recoverHistory(db,state,{verifyBusiness:()=>assertSource(db,r)})
        phase=await history.inspectHistory(db,state);record(phase)
      }else fail('BASELINE_MODE_INVALID')
      return {phase,originalHistoryVerified:true,businessRowsVerified:true}
    })
  }finally{await Promise.all([db.$disconnect(),gateDb.$disconnect()])}
}
module.exports={runPromotion,verifyOriginalRows,quiet}
