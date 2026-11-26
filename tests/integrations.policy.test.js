const test = require('node:test'), assert = require('node:assert/strict')
test('the key scope is always a ceiling even when its owner is an administrator', () => {
  const { assertScopeAccess, effectiveScopes } = require('../src/modules/integrations/policy')
  const principal={isAdmin:true,inventoryEnabled:true,permissions:[],branches:[{id:'a',name:'A'}]}
  assert.deepEqual(effectiveScopes(principal,['products.read']),['products.read'])
  assert.throws(()=>assertScopeAccess(principal,['products.read'],['foreign']),{status:403})
  assert.deepEqual(effectiveScopes({...principal,inventoryEnabled:false},['products.read']),[])
  assert.deepEqual(effectiveScopes({...principal,isAdmin:false,permissions:[]},['products.read']),[])
  assert.throws(()=>assertScopeAccess(principal,['*'],['a']),{status:403})
})
test('a fresh principal uses current membership, roles, modules and assigned branches', async () => {
  const {loadIntegrationPrincipal}=require('../src/modules/integrations/policy')
  let membership={status:'ACTIVE',company:{active:true},role:{id:1,name:'Empleado',company_id:'c',permissions:[{permission:{code:'products.view'}}]}}
  const db={userCompany:{findUnique:async()=>membership},userBranch:{findMany:async()=>[{branch:{id:'b',company_id:'c',active:true,name:'Principal'}}]},companyModule:{findMany:async()=>[]},systemSetting:{findMany:async()=>[]}}
  const a=await loadIntegrationPrincipal(db,{companyId:'c',ownerId:'u'})
  assert.ok(a.permissions.includes('products.view'));assert.equal(a.branches[0].id,'b')
  membership={...membership,status:'SUSPENDED'}
  await assert.rejects(()=>loadIntegrationPrincipal(db,{companyId:'c',ownerId:'u'}),{status:401})
})
