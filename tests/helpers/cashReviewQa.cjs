const fs = require('node:fs'), path = require('node:path'), { randomUUID } = require('node:crypto')
const custodyQa = require('./cashCustodyQa.cjs')
const migration = fs.readFileSync(path.join(__dirname, '../../prisma/migrations/20261101100000_cash_review/migration.sql'), 'utf8')
// Base QA aislada (127.0.0.1/auna_cash_review_qa): hasta 3B.2 aplicadas y 3C opcional.
async function qaSchema(url, { migrate = true } = {}) {
  const qa = await custodyQa.qaSchema(url)
  const apply = () => qa.sql('BEGIN;\n' + migration + '\nCOMMIT;')
  if (migrate) apply()
  return { ...qa, apply }
}
// Arqueo directo por SQL para probar las guardas sin pasar por los comandos.
async function closure(db, f, { version = 1, result = 'CLEAN', supersedes = null, status = 'Pendiente', snapshot = { v: 1 } } = {}) {
  const id = randomUUID()
  await db.$executeRaw`INSERT INTO cash_closures(id,branch_id,start_date,end_date,cashier_name,cashier_id,theoretical_total,theoretical_sales,theoretical_returns,actual_total,difference,total_transactions,total_customers,average_ticket,status,updated_at,calculation_snapshot)
    VALUES(${id}::uuid,${f.branch.id}::uuid,now(),now(),'QA',${f.user.id}::uuid,100,100,0,95,-5,1,1,100,${status},now(),${JSON.stringify(snapshot)}::jsonb)`
  // El arqueo nace en flujo 0 (también antes de la migración) y entra al 1 por la conversión única.
  if (version === 1) await db.$executeRaw`UPDATE cash_closures SET review_flow_version=1,supersedes_closure_id=${supersedes}::uuid,policy_snapshot='{"cash":"0"}',review_result=${result},review_classification='{"lines":[]}' WHERE id=${id}::uuid`
  return id
}
const review = (db, f, closureId, action, reason = 'Revisado') =>
  db.$executeRaw`INSERT INTO cash_closure_reviews(cash_closure_id,action,reason,actor_id) VALUES(${closureId}::uuid,${action},${reason},${f.user.id}::uuid)`
module.exports = { qaSchema, fixture: custodyQa.fixture, closure, review }
