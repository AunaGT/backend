const test=require('node:test'),assert=require('node:assert/strict'),{Prisma}=require('@prisma/client')
test('role identity is tenant-scoped, revisioned and not globally unique by name',()=>{
 const role=Prisma.dmmf.datamodel.models.find(m=>m.name==='Role')
 for(const name of ['system_key','legacy_role_id','revision','name_key'])assert.ok(role.fields.find(f=>f.name===name),`Missing ${name}`)
 assert.equal(role.fields.find(f=>f.name==='name').isUnique,false)
 assert.ok(role.uniqueFields.some(f=>f.join(',')==='company_id,name_key'))
})
