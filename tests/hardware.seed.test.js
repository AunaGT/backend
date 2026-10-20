const test=require('node:test'),assert=require('node:assert/strict')
test('specific hardware seed is idempotent and grants nothing to custom roles',async()=>{
  const {seedHardwarePermissions}=require('../src/modules/config/hardware/seed'),rows=new Map()
  const db={permission:{createMany:async({data})=>{for(const row of data)rows.set(row.code,row);return{count:data.length}}}}
  await seedHardwarePermissions(db);await seedHardwarePermissions(db)
  assert.deepEqual([...rows.keys()].sort(),['hardware.manage','hardware.test_drawer','hardware.test_print','hardware.view'])
  const {expandPermissions}=require('../src/config/permissionDeps')
  const expanded=expandPermissions(['hardware.manage'])
  assert.ok(expanded.includes('settings.view'));assert.ok(expanded.includes('hardware.view'));assert.ok(!expanded.includes('settings.manage'))
})
