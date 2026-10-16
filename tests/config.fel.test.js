const test=require('node:test'),assert=require('node:assert/strict')
const {withMocks,jsonResponse}=require('./helpers/reportHarness.cjs')
test('fiscal activation is company-scoped, validated, and does not submit existing sales',async()=>{
  const rows=new Map(),model=require.resolve('../src/models/prisma'),target=require.resolve('../src/modules/config/controller')
  const db={systemSetting:{upsert:async({where,create,update})=>{assert.equal(where.company_id_key.company_id,'company-a');const key=where.company_id_key.key;rows.set(key,{...create,...update});return rows.get(key)},findMany:async({where})=>{assert.equal(where.company_id,'company-a');return [...rows.values()]}}}
  db.$transaction=async run=>run(db)
  db.$queryRaw=async()=>[]
  db.systemSetting.create=async({data})=>{const row={...data,revision:1};rows.set(data.key,row);return row}
  db.systemSetting.updateMany=async({where,data})=>{const old=rows.get(where.key);if(old?.revision!==where.revision)return{count:0};rows.set(where.key,{...old,...data,revision:old.revision+1});return{count:1}}
  await withMocks({[model]:{prisma:db,prismaTransaction:db}},target,async controller=>{
    const invalid=jsonResponse();await controller.update({companyId:'company-a',body:{fel_enabled:'yes'}},invalid,e=>{throw e});assert.equal(invalid.statusCode,400);assert.equal(rows.size,0)
    const saved=jsonResponse();await controller.update({companyId:'company-a',body:{fel_enabled:true,expectedRevisions:{fel_enabled:0}}},saved,e=>{throw e});assert.equal(saved.statusCode,200);assert.equal(rows.get('fel_enabled').value,'true')
    const publicSettings=jsonResponse();await controller.getPublic({companyId:'company-a'},publicSettings,e=>{throw e});assert.equal(publicSettings.body.fel_enabled,'true')
    await controller.update({companyId:'company-a',body:{fel_enabled:false,expectedRevisions:{fel_enabled:1}}},jsonResponse(),e=>{throw e});assert.equal(rows.get('fel_enabled').value,'false')
  })
})
