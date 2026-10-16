const test=require('node:test'),assert=require('node:assert/strict'),{withMocks,jsonResponse}=require('./helpers/reportHarness.cjs')
test('history scopes both count and page to permitted business keys in the resolved company',async()=>{
  const queries=[],db={settingAuditEvent:{count:async args=>{queries.push(args);return 1},findMany:async args=>{queries.push(args);return[{id:'event',key:'company_name',before_value:'Antes',after_value:'Después',actor_id:null,revision:2}]}}}
  await withMocks({[require.resolve('../src/models/prisma')]:{prisma:db}},require.resolve('../src/modules/config/controller'),async controller=>{
    const res=jsonResponse();await controller.history({companyId:'A',user:{permissions:['settings.view']},query:{page:'1',pageSize:'10'}},res,e=>{throw e})
    assert.equal(res.body.totalItems,1)
    for(const q of queries){assert.equal(q.where.company_id,'A');assert.ok(q.where.key.in.includes('company_name'));assert.ok(!q.where.key.in.includes('payroll.rates'));assert.ok(!q.where.key.in.includes('accounting.defaultAccounts'));assert.ok(!q.where.key.in.includes('secret.token'))}
  })
})
test('history resolves author names only through membership of the same company',async()=>{
  const event={id:'event',key:'company_name',actor_id:'actor',revision:2},db={settingAuditEvent:{count:async()=>1,findMany:async()=>[event]},user:{findMany:async({where})=>{assert.deepEqual(where.user_companies,{some:{company_id:'A'}});assert.deepEqual(where.id,{in:['actor']});return[{id:'actor',name:'Operador QA'}]}}}
  await withMocks({[require.resolve('../src/models/prisma')]:{prisma:db}},require.resolve('../src/modules/config/controller'),async controller=>{
    const res=jsonResponse();await controller.history({companyId:'A',user:{permissions:['settings.view']},query:{}},res,e=>{throw e});assert.equal(res.body.items[0].actor_name,'Operador QA')
  })
})
