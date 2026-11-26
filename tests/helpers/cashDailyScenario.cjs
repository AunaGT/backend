const {withMocks,jsonResponse}=require('./reportHarness.cjs')
async function countAndFinalize(db,f,sessionId,delta=0){
  await db.$executeRaw`UPDATE cash_register_sessions SET status='CLOSED',closed_at=clock_timestamp() WHERE id=${sessionId}::uuid AND status='OPEN'`
  const req={companyId:f.company.id,branchId:f.branch.id,user:{sub:f.user.id,name:'Cajero QA',permissions:['cashclosure.create_own']},query:{cashier_id:f.user.id,cash_register_session_id:sessionId}}
  const calc=await require('../../src/modules/cash-closure/theoretical').calculateTheoreticalData(db,req)
  const {Prisma}=require('@prisma/client'),D=v=>new Prisma.Decimal(String(v))
  const rows=calc.payment_breakdown.map(m=>({...m,actual_amount:D(m.theoretical_amount).add(m.settlement_kind==='CASH'?delta:0).toFixed(2),notes:delta&&m.settlement_kind==='CASH'?'Moneda faltante':null}))
  let error;const res=jsonResponse()
  await withMocks({[require.resolve('../../src/models/prisma')]:{prisma:db}},require.resolve('../../src/modules/cash-closure/controller'),async c=>c.create({...req,body:{cashierId:f.user.id,cash_register_session_id:sessionId,calculationKey:calc.calculation_key,actualTotal:rows.reduce((s,r)=>s.add(r.actual_amount),D(0)).toFixed(2),paymentBreakdowns:rows,denominations:[]}},res,e=>error=e))
  if(error)throw error
  if(res.statusCode!==201)throw new Error(JSON.stringify(res.body))
  const [c]=await db.$queryRaw`SELECT id,updated_at FROM cash_closures WHERE id=${res.body.id}::uuid`
  await db.$transaction(tx=>require('../../src/modules/cash-closure/reviewFlow').finalize(tx,{...f.scope,userId:f.other.id,userName:'Encargada',canReview:true},c.id,{expectedUpdatedAt:new Date(c.updated_at).toISOString(),reason:'Conteo revisado; diferencia documentada'}))
  return c.id
}
module.exports={countAndFinalize}
