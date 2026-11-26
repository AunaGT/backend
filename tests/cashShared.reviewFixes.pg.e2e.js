const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto')
const {qaSchema,fixture}=require('./helpers/cashSharedQa.cjs'),{withMocks,jsonResponse}=require('./helpers/reportHarness.cjs')
const url=process.env.AUNA_CASH_DAILY_QA_URL
test('joined shared work is discoverable without a default, including returns-only users and effective list capability', {skip:!url,timeout:120000},async()=>{
 const {db}=await qaSchema(url)
 try{
  const f=await fixture(db),turn=await f.open();await db.$transaction(tx=>require('../src/services/cashSharedSessions').join(tx,f.otherScope,turn.id))
  await withMocks({[require.resolve('../src/models/prisma')]:{prisma:db}},require.resolve('../src/modules/sales/cashSessions.controller'),async api=>{
   const request=permissions=>({companyId:f.company.id,branchId:f.branch.id,user:{sub:f.other.id,permissions},query:{}})
   const call=async(action,req)=>{const res=jsonResponse();res.set=()=>res;let error;await api[action](req,res,e=>error=e);if(error)throw error;return res}
   for(const permissions of [['sales.create'],['returns.complete'],['receivables.manage']]){
    const res=await call('getCurrent',request(permissions));assert.equal(res.statusCode,200,JSON.stringify(res.body));assert.equal(res.body.session.id,turn.id)
   }
   const list=await call('listRegisters',request(['sales.create']))
   assert.equal(list.body.find(r=>r.id===f.register2.id).open_session.can_operate,true)
   await db.$executeRaw`UPDATE cash_register_access SET active=false WHERE register_id=${f.register2.id}::uuid AND user_id=${f.other.id}::uuid`
   const after=await call('listRegisters',request(['sales.create']))
   assert.equal(after.body.find(r=>r.id===f.register2.id).open_session.can_operate,false)
  })
 }finally{await db.$disconnect()}
})
test('legacy shared boxes keep ordinary edits and have an explicit closed-turn path to individual ledger setup', {skip:!url,timeout:120000},async()=>{
 const {db}=await qaSchema(url)
 try{
  const f=await fixture(db),id=randomUUID(),config=require('../src/modules/sales/cashRegisters.configuration')
  await db.$executeRaw`INSERT INTO cash_registers(id,branch_id,name,code,operation_mode,currency_code,updated_at) VALUES(${id}::uuid,${f.branch.id}::uuid,'Anterior','OLD-SHARED','SHARED','GTQ',now())`
  const saved=await db.$transaction(tx=>config.saveRegisterConfiguration(tx,f.scope,{id,expectedRevision:1,requestKey:randomUUID(),name:'Nombre corregido',authorizedUserIds:[f.user.id,f.other.id]}))
  assert.equal(saved.operation_mode,'SHARED');assert.equal(saved.money_event_version,0)
  const next=await db.$transaction(tx=>config.saveRegisterConfiguration(tx,f.scope,{id,expectedRevision:saved.revision,requestKey:randomUUID(),name:saved.name,operationMode:'INDIVIDUAL'}))
  assert.equal(next.operation_mode,'INDIVIDUAL');assert.equal(next.money_event_version,0)
 }finally{await db.$disconnect()}
})
