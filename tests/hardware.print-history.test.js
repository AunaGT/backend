const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto')
const {harness,ids}=require('./helpers/hardwareHarness.cjs')
const {printHistory,reprintJob}=require('../src/modules/config/hardware/printing/service')
async function fixture(){
 const h=harness()
 h.scope.permissions=['hardware.view','sales.view']
 for(const actor of [ids.actor,randomUUID()])await h.db.hardwarePrintJob.create({data:{company_id:ids.company,branch_id:ids.branch,actor_id:actor,source_kind:'SALE_TICKET',source_id:randomUUID(),state:'CREATED',document:'MAIN'}})
 const findMany=h.db.hardwarePrintJob.findMany
 h.db.hardwarePrintJob.findMany=async query=>(await findMany(query)).map(row=>Object.fromEntries(Object.keys(query.select).filter(key=>query.select[key]).map(key=>[key,row[key]])))
 return h
}
test('administrative history keeps other actors visible but offers copies only for the current actor',async()=>{
 const h=await fixture(),history=await printHistory(h.db,h.scope)
 const own=history.items.find(row=>row.id===h.rows('hardwarePrintJob')[0].id),other=history.items.find(row=>row.id===h.rows('hardwarePrintJob')[1].id)
 assert.equal(history.totalItems,2)
 assert.equal(own.capabilities?.reprint,true)
 assert.equal(other.capabilities?.reprint,false)
 assert.equal(own.actorId,undefined);assert.equal(own.actor_id,undefined)
 await assert.rejects(reprintJob(h.db,{...h.scope,isAdmin:true},other.id,{requestKey:randomUUID(),reason:'Copia ajena'}),error=>error.status===404)
})
test('history copies require a concrete branch and current source permissions',async()=>{
 const h=await fixture()
 for(const overrides of [{permissions:['hardware.view']},{branchId:null,isConsolidated:true},{isConsolidated:true}]){
  const history=await printHistory(h.db,{...h.scope,...overrides})
  assert.equal(history.items.length,2)
  assert.ok(history.items.every(row=>row.capabilities?.reprint===false))
 }
 await h.db.hardwarePrintJob.updateMany({where:{},data:{source_kind:'LABEL_PREPARATION'}})
 assert.ok((await printHistory(h.db,h.scope)).items.every(row=>row.capabilities?.reprint===false))
 const history=await printHistory(h.db,{...h.scope,permissions:['hardware.view','products.view','products.export']})
 assert.equal(history.items.find(row=>row.id===h.rows('hardwarePrintJob')[0].id).capabilities?.reprint,true)
})
