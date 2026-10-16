const test = require('node:test'), assert = require('node:assert/strict')
const { withMocks, jsonResponse } = require('./helpers/reportHarness.cjs')
const target = require.resolve('../src/modules/config/controller'), model = require.resolve('../src/models/prisma')
const policy = { windowDays: 30, allowAuthorizedExceptions: true, exchangePricing: 'CURRENT_PRICE', enabledResolutions: ['REFUND_CASH'] }
function fixture() {
  const rows = [{ company_id: 'B', key: 'returns.policy', type: 'json', value: JSON.stringify({...policy, windowDays: 90}) }], writes = []
  const db = { systemSetting: {
    findMany: async ({where}) => rows.filter(r => r.company_id === where.company_id),
    upsert: async ({create,update,where}) => {
      assert.equal(where.company_id_key.company_id,create.company_id); writes.push(create)
      const old = rows.find(r=>r.company_id===create.company_id && r.key===create.key)
      if(old) Object.assign(old,update); else rows.push(create)
    },
  }, $transaction:async run=>run(db) }
  return {db,rows,writes}
}
test('invalid return policies reject the entire PATCH before opening a transaction', async () => {
  let transactions=0
  const db={$transaction:async()=>{transactions++;throw Error('No debe abrir una transacción')}}
  const invalid=[null,[],true,'{}', ...[true,[4],{},'',0,-1,1.5,Infinity,Number.MAX_SAFE_INTEGER+1].map(windowDays=>({...policy,windowDays})), ...['false',0,null].map(allowAuthorizedExceptions=>({...policy,allowAuthorizedExceptions})), ...[[],['UNKNOWN'],['REFUND_CASH','UNKNOWN'],'REFUND_CASH',null].map(enabledResolutions=>({...policy,enabledResolutions})), {...policy,exchangePricing:'UNKNOWN'}]
  await withMocks({[model]:{prisma:db,prismaTransaction:db}},target,async controller=>{
    for(const value of invalid) {
      const res=jsonResponse();let error
      await controller.update({companyId:'A',body:{settings:{company_name:'No guardar','returns.policy':value}}},res,e=>{error=e})
      assert.equal(error,undefined,JSON.stringify(value));assert.equal(res.statusCode,400,JSON.stringify(value))
    }
  })
  assert.equal(transactions,0)
})
test('return policy persists one canonical JSON value only for the resolved company', async () => {
  const {db,rows,writes}=fixture(),other=structuredClone(rows[0])
  await withMocks({[model]:{prisma:db,prismaTransaction:db}},target,async controller=>{
    const res=jsonResponse()
    await controller.update({companyId:'A',body:{settings:{'returns.policy':{...policy,windowDays:'45',enabledResolutions:['REFUND_CASH','REFUND_CASH']}}}},res,e=>{throw e})
    assert.equal(res.statusCode,200);assert.deepEqual(res.body['returns.policy'],{...policy,windowDays:45})
  })
  assert.equal(writes.length,1);assert.equal(writes[0].type,'json');assert.equal(writes[0].company_id,'A');assert.deepEqual(rows[0],other)
})
test('legacy PATCH optional policy fields retain their compatible effective defaults', async () => {
  const {db}=fixture()
  await withMocks({[model]:{prisma:db,prismaTransaction:db}},target,async controller=>{
    const res=jsonResponse()
    await controller.update({companyId:'A',body:{'returns.policy':{windowDays:15,exchangePricing:'ORIGINAL_SALE_PRICE'}}},res,e=>{throw e})
    assert.equal(res.statusCode,200);assert.equal(res.body['returns.policy'].allowAuthorizedExceptions,true);assert.equal(res.body['returns.policy'].enabledResolutions.length,5)
  })
})
test('private settings expose the same effective policy as returns without writing defaults', async () => {
  const {db,rows,writes}=fixture()
  await withMocks({[model]:{prisma:db,prismaTransaction:db}},target,async controller=>{
    for(const [companyId,days] of [['A',30],['B',90]]) { const res=jsonResponse();await controller.getAll({companyId},res,e=>{throw e});assert.equal(res.body['returns.policy'].windowDays,days) }
    rows.push({company_id:'C',key:'returns.policy',type:'json',value:'invalid JSON'})
    const res=jsonResponse();await controller.getAll({companyId:'C'},res,e=>{throw e});assert.equal(res.body['returns.policy'].windowDays,30)
  })
  assert.equal(writes.length,0)
})
test('a failed policy read is not presented as a successful default configuration', async()=>{
  const failed=Error('Base no disponible'),db={systemSetting:{findMany:async()=>{throw failed}}}
  await withMocks({[model]:{prisma:db,prismaTransaction:db}},target,async controller=>{const res=jsonResponse();let error;await controller.getAll({companyId:'A'},res,e=>{error=e});assert.equal(error,failed);assert.equal(res.body,null)})
})
