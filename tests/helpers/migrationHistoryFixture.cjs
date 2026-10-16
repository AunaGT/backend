const {fingerprintRows}=require('../../scripts/migrations/inventory')
function historyFixture(phase='CAPTURED'){
  const original=[{id:'old',migration_name:'legacy',checksum:'old-checksum',finished_at:'2026-01-01',rolled_back_at:null}]
  const receipt={runId:'11111111-1111-4111-8111-111111111111',historyOid:'41',historyHash:fingerprintRows(original.map(r=>JSON.stringify(r))),baselineChecksum:'baseline-checksum',paymentChecksum:'payment-checksum'}
  const tables=new Map(),ddl=[]
  const row=(name,checksum)=>({id:name,migration_name:name,checksum,finished_at:'2026-10-15',rolled_back_at:null})
  const newer=[row('0_auna_baseline_20261015',receipt.baselineChecksum),...(phase==='PAYMENTS_APPLIED'?[row('202610150002_company_payment_methods',receipt.paymentChecksum)]:[])]
  if(phase==='CAPTURED')tables.set('public._prisma_migrations',{oid:'41',rows:original})
  else{tables.set('auna_migration_audit._prisma_migrations_20261015',{oid:'41',rows:original});if(phase!=='ARCHIVED')tables.set('public._prisma_migrations',{oid:'42',rows:newer})}
  const db={receipt,tables,ddl,$transaction:async work=>work(db),$executeRawUnsafe:async sql=>{ddl.push(sql);throw Error('Unexpected fixture DDL: '+sql)},$queryRawUnsafe:async(sql,...args)=>{
    if(sql.includes('FROM pg_class c JOIN pg_namespace')){const t=tables.get(args[0]+'.'+args[1]);return t?[{oid:t.oid}]:[]}
    const match=sql.match(/FROM "([^"]+)"\."([^"]+)" h/)
    if(match)return tables.get(match[1]+'.'+match[2]).rows.map(r=>({row:JSON.stringify(r)}))
    throw Error('Unexpected fixture query: '+sql)
  }}
  return db
}
module.exports={historyFixture}
