const test=require('node:test'),assert=require('node:assert/strict')
const api=()=>{try{return require('../src/services/saleStockAlertOutbox')}catch(e){if(e.code==='MODULE_NOT_FOUND')return{};throw e}}
function fixture(){
 const state={jobs:[],stock:'3',seen:[],fail:false},locks=new Set();let next=0
 const db={$transaction:async run=>{
  const staged=[],deleted=new Set(),claims=[]
  const tx={
   $executeRaw:async(strings,...args)=>{const sql=String(strings)
    if(sql.includes('INSERT INTO sale_stock_alert_outbox')){const [sale_id,company_id,branch_id,ids]=args;if(![...state.jobs,...staged].some(j=>j.sale_id===sale_id))staged.push({id:++next,sale_id,company_id,branch_id,product_ids:JSON.parse(ids),attempts:0});return 1}
    if(sql.includes('DELETE FROM sale_stock_alert_outbox')){deleted.add(args[0]);return 1}
    if(sql.includes('UPDATE sale_stock_alert_outbox')){const job=state.jobs.find(j=>j.id===args.at(-1));job.attempts++;job.last_error=args[0];job.delayed=true;return 1}
    assert.match(sql,/SAVEPOINT/);return 0
   },
   $queryRaw:async(strings,...args)=>{const sql=String(strings)
    if(sql.includes('SKIP LOCKED')){const job=state.jobs.find(j=>!j.delayed&&!locks.has(j.id));if(!job)return[];locks.add(job.id);claims.push(job.id);return[{...job}]}
    if(sql.includes('pg_try_advisory_xact_lock'))return[{locked:true}]
    assert.fail('Unexpected query '+sql)
   },
   productStock:{findMany:async({where})=>{assert.equal(where.branch_id,'B');assert.equal(where.product.company_id,'A');return where.product_id.in.map(product_id=>({product_id,stock:state.stock,min_stock:'5'}))}},
  }
  try{const result=await run(tx);state.jobs=state.jobs.filter(j=>!deleted.has(j.id));state.jobs.push(...staged);return result}finally{claims.forEach(id=>locks.delete(id))}
 }}
 const alert=async(tx,products,branch,options)=>{assert.equal(options.strict,true);state.seen.push(products);if(state.fail)throw Error('SECRET://password')}
 return{db,state,alert}
}
const scope={saleId:'S',companyId:'A',branchId:'B',productIds:['P','P']}
test('sale alerts are invisible before commit, unique on replay, absent on rollback and resumable after restart',async()=>{
 assert.equal(typeof api().enqueueSaleStockAlerts,'function');const f=fixture()
 await assert.rejects(f.db.$transaction(async tx=>{await api().enqueueSaleStockAlerts(tx,scope);assert.equal(await api().processNextSaleStockAlert(f.db,{ensureAlerts:f.alert}),'idle');throw Error('rollback')}),/rollback/)
 assert.equal(f.state.jobs.length,0)
 await f.db.$transaction(tx=>api().enqueueSaleStockAlerts(tx,scope));await f.db.$transaction(tx=>api().enqueueSaleStockAlerts(tx,scope))
 assert.equal(f.state.jobs.length,1);assert.deepEqual(f.state.jobs[0].product_ids,['P'])
 f.state.stock='9';assert.equal(await api().processNextSaleStockAlert(f.db,{ensureAlerts:f.alert}),'processed');assert.equal(f.state.jobs.length,0);assert.equal(f.state.seen[0][0].stock,'9')
})
test('failed alert retains a delayed durable job without leaking its error or freezing stock',async()=>{
 assert.equal(typeof api().processNextSaleStockAlert,'function');const f=fixture();await f.db.$transaction(tx=>api().enqueueSaleStockAlerts(tx,scope));f.state.fail=true
 assert.equal(await api().processNextSaleStockAlert(f.db,{ensureAlerts:f.alert}),'retry');assert.equal(f.state.jobs[0].attempts,1);assert.equal(f.state.jobs[0].last_error,'ALERT_PROCESSING_FAILED')
 f.state.fail=false;f.state.jobs[0].delayed=false;f.state.stock='1';await api().processNextSaleStockAlert(f.db,{ensureAlerts:f.alert});assert.equal(f.state.seen.at(-1)[0].stock,'1');assert.equal(f.state.jobs.length,0)
})
test('competing workers skip the claimed job instead of duplicating alerts',async()=>{
 assert.equal(typeof api().processNextSaleStockAlert,'function');const f=fixture();await f.db.$transaction(tx=>api().enqueueSaleStockAlerts(tx,scope))
 let started,finish;const ready=new Promise(r=>started=r),hold=new Promise(r=>finish=r)
 const first=api().processNextSaleStockAlert(f.db,{ensureAlerts:async(...args)=>{started();await hold;await f.alert(...args)}});await ready
 assert.equal(await api().processNextSaleStockAlert(f.db,{ensureAlerts:f.alert}),'idle');finish();await first;assert.equal(f.state.seen.length,1)
})
test('strict stock alerts reject missing catalogs instead of silently losing a job',async()=>{
 const alerts=require('../src/services/stockAlerts'),tx={status:{findFirst:async()=>null},alertType:{findMany:async()=>[]},alertPriority:{findMany:async()=>[]}}
 await assert.rejects(alerts.ensureStockAlertsBatch(tx,[{id:'P',stock:'0',min_stock:'1'}],'B',{strict:true}),e=>e.code==='ALERT_CATALOG_REQUIRED')
})
