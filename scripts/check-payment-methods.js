require('../src/config/loadEnv')
const {prismaTransaction:db}=require('../src/models/prisma')
const {inspectPaymentMethodBasics}=require('../src/services/paymentMethods/basics')
async function main() {
  const columns=await db.$queryRaw`SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='payment_methods' AND column_name='company_id'`
  const rows=columns.length
    ? await db.$queryRaw`SELECT id,name,is_credit,company_id,base_code,settlement_kind FROM payment_methods WHERE company_id IS NULL ORDER BY id`
    : await db.$queryRaw`SELECT id,name,is_credit FROM payment_methods ORDER BY id`
  const result=inspectPaymentMethodBasics(rows)
  console.log(JSON.stringify({sharedIds:rows.map(r=>r.id),sharedCount:rows.length,basics:[...result.byCode.keys()],missing:result.missing}))
}
main().catch(e=>{console.error(e.code||'PM_PREFLIGHT_FAILED',e.code==='PM_SETUP_REQUIRED'?e.message:'No fue posible verificar el catálogo; no se modificaron datos');process.exitCode=1}).finally(()=>db.$disconnect())
