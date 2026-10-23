const test=require('node:test'),assert=require('node:assert/strict')
const {ensureStockAlertsBatch}=require('../src/services/stockAlerts')
const {processNextSaleStockAlert}=require('../src/services/saleStockAlertOutbox')
function fixture(){
 const state={stock:'8',alerts:[],deleted:false},held=new Map()
 let captured,proceed,syncReached;const ready=new Promise(r=>captured=r),resume=new Promise(r=>proceed=r),syncReady=new Promise(r=>syncReached=r)
 const db={$transaction:async run=>{
  const owned=new Map(),worker={value:false}
  async function lock(key,tryOnly){
   if(owned.has(key))return true
   if(held.has(key)){if(tryOnly)return false;syncReached();await held.get(key).done}
   let release;const done=new Promise(r=>release=r);held.set(key,{done,release});owned.set(key,release);return true
  }
  const keys=args=>args.flatMap(v=>v?.values||[])
  const tx={
   $queryRaw:async(strings,...args)=>{
    const sql=String(strings)
    if(sql.includes('SKIP LOCKED')){worker.value=true;return[{id:1,company_id:'A',branch_id:'B',product_ids:['P']}]}
    if(sql.includes('pg_try_advisory_xact_lock')){const values=keys(args);if(!values.length)return[{locked:true}];return Promise.all(values.map(async key=>({locked:await lock(key,true)})))}
    assert.fail(sql)
   },
   $executeRaw:async(strings,...args)=>{
    const sql=String(strings)
    if(sql.includes('pg_advisory_xact_lock')){if(!worker.value)syncReached();for(const key of keys(args))await lock(key,false);return 1}
    if(sql.includes('DELETE FROM'))state.deleted=true
    return 1
   },
   productStock:{findMany:async()=>{const rows=[{id:'P',product_id:'P',stock:state.stock,min_stock:'5'}];if(worker.value){captured();await resume}return rows}},
   status:{findFirst:async({where})=>({id:where.name==='Activa'?1:2})},alertType:{findMany:async()=>[{id:1,name:'Sin Stock'},{id:2,name:'Stock Bajo'}]},alertPriority:{findMany:async()=>['Crítica','Alta','Media','Baja'].map((name,id)=>({name,id:id+1}))},
   alert:{updateMany:async({where,data})=>{if(!worker.value)syncReached();for(const row of state.alerts)if(row.branch_id===where.branch_id&&where.product_id.in.includes(row.product_id)&&row.status_id===where.status_id&&row.resolved===where.resolved)Object.assign(row,data)},findMany:async({where})=>state.alerts.filter(row=>row.status_id===where.status_id&&row.resolved===0),update:async({where,data})=>Object.assign(state.alerts.find(row=>row.id===where.id),data),createMany:async({data})=>{syncReached();state.alerts.push(...data.map((row,i)=>({id:i+1,...row})))}}
  }
  try{return await run(tx)}finally{for(const [key,release]of owned){held.delete(key);release()}}
 }}
 return{db,state,ready,syncReady,proceed}
}
test('a worker cannot resolve the newer low-stock alert written by a concurrent adjustment',async()=>{
 const f=fixture(),worker=processNextSaleStockAlert(f.db)
 await f.ready;f.state.stock='2'
 const sync=f.db.$transaction(tx=>ensureStockAlertsBatch(tx,[{id:'P',stock:'2',min_stock:'5'}],'B'))
 await f.syncReady;f.proceed();await Promise.all([worker,sync])
 assert.equal(f.state.deleted,true);assert.equal(f.state.alerts.length,1);assert.equal(f.state.alerts[0].resolved,0);assert.equal(String(f.state.alerts[0].current_stock),'2')
})
test('a standalone alert refresh rereads stock inside its transaction instead of trusting an old supplied summary',async()=>{
 const f=fixture();f.state.stock='2'
 await ensureStockAlertsBatch(f.db,[{id:'P',stock:'8',min_stock:'5'}],'B')
 assert.equal(f.state.alerts.length,1);assert.equal(f.state.alerts[0].resolved,0);assert.equal(String(f.state.alerts[0].current_stock),'2')
})
