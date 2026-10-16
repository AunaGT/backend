const test=require('node:test'),assert=require('node:assert/strict'),{withMocks,jsonResponse}=require('./helpers/reportHarness.cjs')
test('accounting maintenance seed detects an accountant edit instead of overwriting its mapping',async()=>{
  let row={key:'accounting.defaultAccounts',value:JSON.stringify({cash:'OLD'}),type:'json',revision:1}
  const db={$queryRaw:async()=>[],account:{upsert:async({create})=>({id:create.code})},systemSetting:{
    findUnique:async()=>{const loaded={...row};row={...row,value:JSON.stringify({cash:'ACCOUNTANT'}),revision:2};return loaded},
    updateMany:async({where,data})=>{if(where.revision!==row.revision)return{count:0};row={...row,...data};return{count:1}},
    upsert:async({update})=>{row={...row,...update};return row},findMany:async()=>[row]}}
  const {seedChartOfAccounts}=require('../src/services/accounting/seedChartOfAccounts')
  await assert.rejects(seedChartOfAccounts(db,'A'),e=>e.status===409)
  assert.equal(JSON.parse(row.value).cash,'ACCOUNTANT')
})
test('settings history restricts count and rows to both domain permission and effective company module',async()=>{
  const queries=[],db={settingAuditEvent:{count:async args=>{queries.push(args);return 0},findMany:async args=>{queries.push(args);return[]}}}
  let enabled=false
  const modules={getCompanyModuleBlock:async(companyId,code)=>{assert.equal(companyId,'A');assert.ok(['accounting','inventory'].includes(code));return enabled?null:{code:'MODULE_DISABLED'}}}
  await withMocks({[require.resolve('../src/models/prisma')]:{prisma:db},[require.resolve('../src/modules/platform/service')]:modules},require.resolve('../src/modules/config/controller'),async controller=>{
    const req={companyId:'A',user:{permissions:['settings.view','accounting.view','products.view']},query:{}}
    await controller.history(req,jsonResponse(),e=>{throw e})
    assert.equal(queries.length,2);assert.ok(queries.every(q=>!q.where.key.in.includes('accounting.defaultAccounts')&&!q.where.key.in.includes('inventory.barcode_label_layout')))
    enabled=true;queries.length=0;await controller.history(req,jsonResponse(),e=>{throw e})
    assert.ok(queries.every(q=>q.where.key.in.includes('accounting.defaultAccounts')&&q.where.key.in.includes('inventory.barcode_label_layout')))
  })
})
test('new employee bonus uses the Guatemala date at the evening UTC boundary',async t=>{
  t.mock.timers.enable({apis:['Date'],now:new Date('2026-10-17T01:00:00Z')})
  let created
  const db={employee:{findMany:async()=>[]},payrollRateVersion:{findMany:async()=>[
    {id:'BASE',company_id:'A',is_baseline:true,effective_from:null,rates:{...require('../src/services/payroll/rates').DEFAULT_RATES,bonificacionIncentivo:250}},
    {id:'FUTURE',company_id:'A',is_baseline:false,effective_from:new Date('2026-10-17'),rates:{...require('../src/services/payroll/rates').DEFAULT_RATES,bonificacionIncentivo:500}}]}}
  const controllerPath=require.resolve('../src/modules/hr/controllers/employees'),documentService=require.resolve('../src/modules/hr/employeeApplication')
  await withMocks({[require.resolve('../src/models/prisma')]:{prisma:db},[documentService]:{createEmployeeWithDocuments:async(scope,data)=>{created=data;return data}}},controllerPath,async controller=>{
    const res=jsonResponse();await controller.create({companyId:'A',branchId:'B',user:{sub:'U'},body:{first_name:'QA',last_name:'QA',hire_date:'2026-10-16',base_salary:1000}},res,e=>{throw e})
    assert.equal(created.bonificacion_incentivo,250)
  })
})
test('actual Storage helper reports SDK removal error, exception and success explicitly',async()=>{
  const keys=['SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY'],before=keys.map(key=>process.env[key]);process.env.SUPABASE_URL='https://qa.invalid';process.env.SUPABASE_SERVICE_ROLE_KEY='fake-test-key'
  let mode='error'
  const sdk={createClient:()=>({storage:{from:()=>({remove:async()=>{if(mode==='throw')throw Error('Offline');return{error:mode==='error'?{message:'SDK failure'}:null}}})}})}
  try{await withMocks({[require.resolve('@supabase/supabase-js')]:sdk},require.resolve('../src/services/supabaseStorage'),async helper=>{
    assert.equal(await helper.removePublicObject('https://qa.invalid/storage/v1/object/public/logo/A/test.png','logo'),false)
    mode='throw';assert.equal(await helper.removePublicObject('https://qa.invalid/storage/v1/object/public/logo/A/test.png','logo'),false)
    mode='success';assert.equal(await helper.removePublicObject('https://qa.invalid/storage/v1/object/public/logo/A/test.png','logo'),true)
  })}finally{keys.forEach((key,i)=>{if(before[i]===undefined)delete process.env[key];else process.env[key]=before[i]})}
})
