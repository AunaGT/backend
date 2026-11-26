const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path')
const {randomUUID,createHash}=require('node:crypto'),{execFileSync}=require('node:child_process')
const root=path.resolve(__dirname,'../..')
function validateQaUrl(raw) {
  const url=new URL(raw)
  assert.equal(url.hostname,'127.0.0.1','QA local únicamente')
  assert.equal(url.pathname,'/auna_cash_disputes_qa','Base QA de disputas únicamente')
  return url
}
// A separate generated client keeps both localhost and sibling QA clients intact.
if(process.env.AUNA_CASH_DISPUTES_QA_URL) {
  const url=validateQaUrl(process.env.AUNA_CASH_DISPUTES_QA_URL)
  const source=fs.readFileSync(path.join(root,'prisma/schema.prisma'),'utf8')
  const out=path.join('/tmp/auna-disputes-prisma',createHash('sha256').update(source).digest('hex').slice(0,16))
  const schema=path.join(root,'.superpowers/sdd/2026-11-22-cash-payment-disputes',path.basename(out)+'.prisma'),client=path.join(out,'client')
  if(!fs.existsSync(path.join(client,'index.js'))) {
    fs.mkdirSync(out,{recursive:true})
    fs.writeFileSync(schema,source.replace(/provider\s*=\s*"prisma-client-js"/,'provider = "prisma-client-js"\n  output = "'+client+'"'))
    execFileSync(process.execPath,[require.resolve('prisma/build/index.js'),'generate','--schema',schema],{cwd:root,env:{...process.env,DATABASE_URL:url.href,DIRECT_URL:url.href,PRISMA_GENERATE_SKIP_AUTOINSTALL:'true'},stdio:'pipe'})
  }
  require('@prisma/client');require.cache[require.resolve('@prisma/client')].exports=require(client)
}
const base=require('./cashSharedQa.cjs')
const names=['20261122220000_cash_dispute_sources','20261122220100_cash_payment_disputes']
const tables=['cash_refund_allocations','customer_recovery_credit_applications','customer_recovery_credits','customer_dispute_charge_applications','customer_dispute_charges','customer_receipt_restrictions','cash_dispute_lots','cash_dispute_commands','cash_dispute_proposals','cash_dispute_events','cash_payment_disputes','cash_dispute_settings']
async function qaSchema(raw,{migrate=true}={}) {
  validateQaUrl(raw)
  // Read the exact migrations before opening any database connection.
  const migrations=names.map(n=>fs.readFileSync(path.join(root,'prisma/migrations',n,'migration.sql'),'utf8'))
  const qa=await base.qaSchema(raw)
  qa.sql(tables.map(t=>`DROP TABLE IF EXISTS ${t};`).join('\n'))
  const apply=()=>{qa.sql(migrations[0]);qa.sql('BEGIN;\n'+migrations[1]+'\nCOMMIT;')}
  if(migrate)apply()
  return {...qa,apply}
}
async function fixture(db) {
  const f=await base.fixture(db),period=await f.open()
  const api=require('../../src/modules/cash-closure/bankMethods')
  const p=await db.$transaction(tx=>api.proposeBankMethod(tx,{...f.scope,canManage:true},{paymentMethodId:f.card.id,mode:'DEFERRED',destinationLabel:'Proveedor QA',bankAccountId:f.accounts.bank.id,clearingAccountId:f.accounts.clearing.id,feeAccountId:f.accounts.fee.id}))
  await db.$transaction(tx=>api.approveBankMethod(tx,{...f.scope,isAdmin:true},p.version.id))
  const payment=await db.$transaction(tx=>require('../../src/modules/receivables').applyPayment(tx,{...f.scope,customerId:f.customer.id,amount:100,paymentMethodId:f.card.id,cashRegisterSessionId:period.id,allowAdvance:true}))
  const [event]=await db.$queryRaw`SELECT * FROM cash_money_events WHERE source_id=${payment.paymentId}::uuid`
  return {...f,period,paymentId:payment.paymentId,event,scope:{...f.scope,branchIds:[f.branch.id],can:{read:true,manage:true,movements:true,resolve:false,charge:false}},reviewer:{...f.scope,userId:f.other.id,branchIds:[f.branch.id],can:{read:true,manage:false,movements:false,resolve:true,charge:true}}}
}
async function insertCase(db,f,{id=randomUUID(),claimed='100.00',companyId=f.company.id,reference=randomUUID()}={}) {
  await db.$executeRaw`INSERT INTO cash_payment_disputes(id,company_id,branch_id,event_id,customer_id,payment_method_id,currency_code,claimed,provider_reference,provider_reference_key,reason,created_by_id)
    VALUES(${id}::uuid,${companyId}::uuid,${f.branch.id}::uuid,${f.event.id}::uuid,${f.customer.id}::uuid,${f.card.id},'GTQ',${claimed}::numeric,${reference},${reference.toUpperCase()},'Reclamo QA',${f.user.id}::uuid)`
  return id
}
// Las pruebas PG ejercen el comportamiento liberado; las que prueban el cierre lo cambian localmente.
require('../../src/modules/cash-closure/disputes.release').commandsReleased=()=>true
module.exports={validateQaUrl,qaSchema,fixture,insertCase,tables}
