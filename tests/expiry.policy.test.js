const test=require('node:test'),assert=require('node:assert/strict'),{withMocks}=require('./helpers/reportHarness.cjs')
const policy=()=>require('../src/services/expiryAlertPolicy')
test('a committed unrelated save is not reported as failed because a sibling stored expiry policy is malformed',async()=>{
  const rows=[{key:'inventory.expiry_alert_policy',value:'bad JSON',type:'json',revision:1}],db={systemSetting:{create:async({data})=>{const row={...data,revision:1};rows.push(row);return row},findMany:async()=>rows},company:{update:async()=>{}},$queryRaw:async()=>[]};db.$transaction=async fn=>fn(db)
  const {jsonResponse}=require('./helpers/reportHarness.cjs')
  await withMocks({[require.resolve('../src/models/prisma')]:{prisma:db,prismaTransaction:db}},require.resolve('../src/modules/config/controller'),async controller=>{
    const res=jsonResponse();await controller.update({companyId:'A',body:{settings:{company_name:'Guardado'},expectedRevisions:{company_name:0}}},res,e=>{throw e})
    assert.equal(res.statusCode,200);assert.equal(res.body.company_name,'Guardado')
  })
})
test('expiry settings reject empty, coercible and inverted windows; absence alone gets defaults',async()=>{
  const {validateExpiryAlertPolicy,getExpiryAlertPolicy}=policy()
  for(const value of [null,[],{warningDays:true,highPriorityDays:0},{warningDays:30,highPriorityDays:''},{warningDays:1,highPriorityDays:2},{warningDays:3651,highPriorityDays:7},{warningDays:30,highPriorityDays:[2]}])assert.throws(()=>validateExpiryAlertPolicy(value),e=>e.status===400)
  assert.deepEqual(validateExpiryAlertPolicy({warningDays:'10',highPriorityDays:'0'}),{warningDays:10,highPriorityDays:0})
  assert.deepEqual(await getExpiryAlertPolicy({systemSetting:{findUnique:async()=>null}},'A'),{warningDays:30,highPriorityDays:7})
  await assert.rejects(getExpiryAlertPolicy({systemSetting:{findUnique:async()=>{throw Error('Offline')}}},'A'),/Offline/)
  await assert.rejects(getExpiryAlertPolicy({systemSetting:{findUnique:async()=>({value:'bad JSON'})}},'A'),e=>e.status===409)
})
test('expiry synchronization applies each company window and never resolves failed-company alerts',async t=>{
  t.mock.timers.enable({apis:['Date'],now:new Date('2026-10-16T12:00:00Z')})
  const creates=[],resolves=[],seen=[]
  const db={company:{findMany:async()=>[{id:'A'},{id:'B'},{id:'FAILED'}]},systemSetting:{findUnique:async({where})=>{
    const id=where.company_id_key.company_id;if(id==='FAILED')throw Error('No disponible');return{value:JSON.stringify(id==='A'?{warningDays:10,highPriorityDays:2}:{warningDays:40,highPriorityDays:7})}
  }},status:{findFirst:async({where})=>({id:where.name==='Activa'?1:2})},alertType:{findFirst:async()=>({id:3})},alertPriority:{findMany:async()=>[{id:4,name:'Crítica'},{id:5,name:'Alta'},{id:6,name:'Media'}]},
  productLot:{findMany:async({where})=>{
    const company=where.product.company_id;seen.push([company,where.expiry_date.lte.toISOString()]);assert.deepEqual(where.qty_remaining,{gt:0});assert.deepEqual(where.product.kind,{not:'SERVICE'});assert.deepEqual(where.branch,{company_id:company})
    return [{product_id:company,branch_id:'branch-'+company,lot_code:'L',expiry_date:new Date(company==='A'?'2026-10-18':'2026-11-20'),qty_remaining:1,product:{name:'QA'},location:null},...(company==='B'?[{product_id:'BX',branch_id:'branch-B',lot_code:'Vencido',expiry_date:new Date('2026-10-15'),qty_remaining:1,product:{name:'Vencido'},location:null}]:[])]
  }},alert:{findMany:async({where})=>{assert.ok(['A','B'].includes(where.branch.company_id));return[{id:'old-'+where.branch.company_id,product_id:'old',branch_id:'branch-'+where.branch.company_id}]},updateMany:async args=>resolves.push(args),createMany:async({data})=>creates.push(...data),update:async()=>{}}}
  await withMocks({[require.resolve('../src/models/prisma')]:{prisma:db}},require.resolve('../src/services/lots'),async({syncLotExpiryAlerts})=>{
    const result=await syncLotExpiryAlerts(db,{force:true});assert.equal(result.ok,false)
  })
  assert.deepEqual(seen,[['A','2026-10-26T00:00:00.000Z'],['B','2026-11-25T00:00:00.000Z']])
  assert.deepEqual(creates.map(row=>[row.product_id,row.priority_id]),[['A',5],['B',6],['BX',4]])
  assert.ok(resolves.every(row=>row.where.branch.company_id!=='FAILED'))
})
