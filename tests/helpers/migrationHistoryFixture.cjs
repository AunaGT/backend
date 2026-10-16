const {fingerprintRows}=require('../../scripts/migrations/inventory')
function historyFixture(phase='CAPTURED'){
  const original=[{id:'old',migration_name:'legacy',checksum:'old-checksum',finished_at:'2026-01-01',rolled_back_at:null}]
  const receipt={runId:'11111111-1111-4111-8111-111111111111',historyOid:'41',historyHash:fingerprintRows(original.map(r=>JSON.stringify(r))),baselineChecksum:'baseline-checksum',paymentChecksum:'payment-checksum'}
  const tables=new Map(),ddl=[],namespaces=new Map([['public',{oid:'10',owned:true,restricted:true,marker:null}]])
  const row=(name,checksum)=>({id:name,migration_name:name,checksum,finished_at:'2026-10-15',rolled_back_at:null})
  const newer=[row('0_auna_baseline_20261015',receipt.baselineChecksum),...(phase==='PAYMENTS_APPLIED'?[row('202610150002_company_payment_methods',receipt.paymentChecksum)]:[])]
  const originalTable={oid:'41',rows:original,pk:'_prisma_migrations_pkey'}
  if(phase==='CAPTURED')tables.set('public._prisma_migrations',originalTable)
  else{namespaces.set('auna_migration_audit',{oid:'11',owned:true,restricted:true,marker:'auna:baseline:20261015:'+receipt.runId});tables.set('auna_migration_audit._prisma_migrations_20261015',originalTable);if(phase!=='ARCHIVED')tables.set('public._prisma_migrations',{oid:'42',rows:newer,pk:'_prisma_migrations_pkey'})}
  let nextOid=50
  const db={receipt,tables,ddl,namespaces,installBaseline:()=>tables.set('public._prisma_migrations',{oid:String(nextOid++),rows:[row('0_auna_baseline_20261015',receipt.baselineChecksum)],pk:'_prisma_migrations_pkey'}),$transaction:async work=>{
    const snapshot=structuredClone([...tables]),ns=structuredClone([...namespaces])
    try{return await work(db)}catch(error){tables.clear();for(const [k,v] of snapshot)tables.set(k,v);namespaces.clear();for(const [k,v] of ns)namespaces.set(k,v);throw error}
  },$executeRawUnsafe:async sql=>{
    ddl.push(sql);const s=sql.replaceAll('"','');let m
    if(/^(SET LOCAL|LOCK TABLE|REVOKE)/.test(s))return 0
    if((m=s.match(/^CREATE SCHEMA (\w+)$/))){namespaces.set(m[1],{oid:'11',owned:true,restricted:true,marker:null});return 0}
    if((m=s.match(/^COMMENT ON SCHEMA (\w+) IS '([^']+)'$/))){namespaces.get(m[1]).marker=m[2];return 0}
    if((m=s.match(/^ALTER TABLE (\w+)\.(\w+) RENAME CONSTRAINT (\w+) TO (\w+)$/))){tables.get(m[1]+'.'+m[2]).pk=m[4];return 0}
    if((m=s.match(/^ALTER TABLE (\w+)\.(\w+) SET SCHEMA (\w+)$/))){
      const oldKey=m[1]+'.'+m[2],newKey=m[3]+'.'+m[2],t=tables.get(oldKey)
      if(tables.has(newKey)||[...tables].some(([k,v])=>k.startsWith(m[3]+'.')&&v.pk===t.pk))throw Object.assign(new Error('relation already exists'),{code:'42P07'})
      tables.delete(oldKey);tables.set(newKey,t);return 0
    }
    if((m=s.match(/^ALTER TABLE (\w+)\.(\w+) RENAME TO (\w+)$/))){const k=m[1]+'.'+m[2],n=m[1]+'.'+m[3];if(tables.has(n))throw Error('table collision');const t=tables.get(k);tables.delete(k);tables.set(n,t);return 0}
    throw Error('Unexpected fixture DDL: '+sql)
  },$queryRawUnsafe:async(sql,...args)=>{
    if(sql.includes('obj_description'))return namespaces.has(args[0])?[namespaces.get(args[0])]:[]
    if(sql.includes('FROM pg_namespace WHERE nspname'))return namespaces.has(args[0])?[{oid:namespaces.get(args[0]).oid}]:[]
    if(sql.includes('FROM pg_constraint')&&sql.includes("contype='p'")){const t=tables.get(args[0].replaceAll('"',''));return t?[{name:t.pk}]:[]}
    if(sql.includes('LEFT JOIN pg_index'))return [...tables].filter(([k])=>k.startsWith(args[0]+'.')).flatMap(([k,t])=>[{name:k.split('.')[1],kind:'r',table:k.split('.')[1]},{name:t.pk,kind:'i',table:k.split('.')[1]}])
    if(sql.includes('FROM pg_class c JOIN pg_namespace')){const t=tables.get(args[0]+'.'+args[1]);return t?[{oid:t.oid}]:[]}
    const match=sql.match(/FROM "([^"]+)"\."([^"]+)" h/)
    if(match)return tables.get(match[1]+'.'+match[2]).rows.map(r=>({row:JSON.stringify(r)}))
    throw Error('Unexpected fixture query: '+sql)
  }}
  return db
}
module.exports={historyFixture}
