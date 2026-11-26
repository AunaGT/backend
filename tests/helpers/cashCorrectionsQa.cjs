const fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto'),{execFileSync}=require('node:child_process')
const out='/tmp/auna-correction-prisma',schema=path.join(__dirname,'../../.superpowers/sdd/2026-11-19-cash-finalized-corrections/qa-schema.prisma')
if(process.env.AUNA_CASH_DAILY_QA_URL){
  const url=new URL(process.env.AUNA_CASH_DAILY_QA_URL)
  if(url.hostname!=='127.0.0.1'||url.pathname!=='/auna_cash_daily_qa')throw Error('QA local únicamente')
  if(!fs.existsSync(path.join(out,'client/index.js'))){
    fs.mkdirSync(path.dirname(schema),{recursive:true})
    fs.writeFileSync(schema,fs.readFileSync(path.join(__dirname,'../../prisma/schema.prisma'),'utf8').replace(/provider\s*=\s*"prisma-client-js"/,'provider = "prisma-client-js"\n  output = "'+out+'/client"'))
    execFileSync(process.execPath,[require.resolve('prisma/build/index.js'),'generate','--schema',schema],{env:{...process.env,DATABASE_URL:url.href,DIRECT_URL:url.href},stdio:'pipe'})
  }
  // One runtime per isolated test process: nested Prisma.sql objects must share its Sql class.
  require('@prisma/client');require.cache[require.resolve('@prisma/client')].exports=require(path.join(out,'client'))
}
const base=require('./cashSharedQa.cjs')
const migration=name=>fs.readFileSync(path.join(__dirname,'../../prisma/migrations',name,'migration.sql'),'utf8')
async function qaSchema(url,{migrate=true}={}) {
  const qa=await base.qaSchema(url)
  qa.sql('DROP TABLE cash_closure_correction_commands; DROP TABLE cash_closure_correction_lines; DROP TABLE cash_closure_corrections;')
  const apply=()=>{qa.sql(migration('20261119220000_cash_correction_source'));qa.sql('BEGIN;\n'+migration('20261119220100_cash_closure_corrections')+'\nCOMMIT;')}
  if(migrate)apply()
  // A generated QA-only client leaves the client used by localhost untouched.
  await qa.db.$disconnect()
  const db=new (require(path.join(out,'client')).PrismaClient)({datasources:{db:{url:qa.url}}})
  return {...qa,db,apply}
}
async function fixture(db,{frozen=true,kind='CASH',actual='900.00'}={}) {
  const f=await base.fixture(db),id=randomUUID()
  await db.companyModule.create({data:{company_id:f.company.id,module_code:'accounting',status:'SUSPENDED'}})
  await db.$executeRaw`INSERT INTO cash_closures(id,branch_id,start_date,end_date,date,cashier_name,cashier_id,theoretical_total,theoretical_sales,theoretical_returns,actual_total,difference,total_transactions,total_customers,average_ticket,status,updated_at)
    VALUES(${id}::uuid,${f.branch.id}::uuid,'2026-11-01','2026-11-01','2026-11-01','QA',${f.user.id}::uuid,1000,1000,0,${actual}::numeric,${actual}::numeric-1000,1,1,1000,'Pendiente',now())`
  const [p]=await db.$queryRaw`INSERT INTO cash_closure_payments(cash_closure_id,payment_method_id,theoretical_amount,theoretical_count,actual_amount,difference) VALUES(${id}::uuid,${f.method.id},1000,1,${actual}::numeric,${actual}::numeric-1000) RETURNING id`
  const snap=frozen?{version:1,currency_code:'GTQ',payment_breakdowns:[{id:p.id,payment_method_id:f.method.id,payment_method_name:f.method.name,settlement_kind:kind}]}:{}
  await db.$executeRaw`UPDATE cash_closures SET calculation_snapshot=${JSON.stringify(snap)}::jsonb WHERE id=${id}::uuid`
  await db.$executeRaw`UPDATE cash_closures SET status='Aprobado' WHERE id=${id}::uuid`
  const scope={...f.scope,viewOwn:true,viewTeam:true,mode:'team',branchIds:[f.branch.id],canPropose:true,canReview:true}
  return {...f,id,paymentId:p.id,scope,reviewer:{...scope,userId:f.other.id}}
}
module.exports={qaSchema,fixture}
