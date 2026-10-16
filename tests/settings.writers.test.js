const test=require('node:test'),assert=require('node:assert/strict')
const {withMocks,jsonResponse}=require('./helpers/reportHarness.cjs'),model=require.resolve('../src/models/prisma'),target=require.resolve('../src/modules/config/controller')
test('settings PATCH requires the loaded revisions before opening a transaction',async()=>{
  let transactions=0
  const db={$transaction:async()=>{transactions++;throw Error('No abrir')}}
  await withMocks({[model]:{prisma:db,prismaTransaction:db}},target,async controller=>{
    const res=jsonResponse();let error
    await controller.update({companyId:'A',body:{settings:{company_name:'Nuevo'}}},res,e=>{error=e})
    assert.equal(error,undefined);assert.equal(res.statusCode,428)
  });assert.equal(transactions,0)
})
test('private settings return revision metadata but not another domain or unknown secret',async()=>{
  const db={systemSetting:{findMany:async()=>[{key:'company_name',value:'QA',revision:4},{key:'payroll.rates',value:'secret payroll',revision:2},{key:'secret.token',value:'secret',revision:9}]}}
  await withMocks({[model]:{prisma:db}},target,async controller=>{
    const res=jsonResponse();await controller.getAll({companyId:'A',user:{permissions:['settings.view']}},res,e=>{throw e})
    assert.equal(res.body._revisions.company_name,4);assert.equal(res.body._revisions.timezone,0)
    assert.equal(res.body['payroll.rates'],undefined);assert.equal(res.body['secret.token'],undefined)
  })
})
test('logo conflict rolls back references and removes only the newly uploaded object',async()=>{
  const removed=[],row={key:'company_logo_url',value:'https://owned/old.png',revision:2}
  const db={systemSetting:{findFirst:async()=>row},$transaction:async fn=>fn({$queryRaw:async()=>[],systemSetting:{findFirst:async()=>row,updateMany:async()=>({count:0})},company:{update:async()=>{throw Error('No cambiar Company')}}})}
  const storage=require.resolve('../src/services/supabaseStorage')
  await withMocks({[model]:{prisma:db,prismaTransaction:db},[storage]:{COMPANY_LOGO_BUCKET:'logo',uploadImageBuffer:async()=>'https://owned/new.png',removePublicObject:async url=>removed.push(url)}},target,async controller=>{
    const res=jsonResponse();await controller.uploadLogo({companyId:'A',body:{expectedRevision:'1'},user:{sub:null},file:{mimetype:'image/png',buffer:Buffer.from('png')}},res,e=>{throw e})
    assert.equal(res.statusCode,409)
  });assert.deepEqual(removed,['https://owned/new.png'])
})
test('company identity and accounting editors cannot bypass expected revisions',async()=>{
  let transactions=0
  const db={userCompany:{findUnique:async()=>({status:'ACTIVE'})},$transaction:async()=>{transactions++;throw Error('No abrir')}}
  for(const [path,req] of [['../src/controllers/companies.controller',{params:{id:'A'},user:{sub:'U'},body:{name:'Nuevo'}}],['../src/modules/accounting/controller',{companyId:'A',body:{defaults:{}}}]]){
    await withMocks({[model]:{prisma:db,prismaTransaction:db}},require.resolve(path),async controller=>{
      let error;await controller[path.includes('companies')?'update':'updateConfig'](req,jsonResponse(),e=>{error=e});assert.equal(error.status,428)
    })
  }
  assert.equal(transactions,0)
})
