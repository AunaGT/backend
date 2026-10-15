const test=require('node:test'),assert=require('node:assert/strict')
const {assertCommercialAccess}=require('../src/modules/appointments/access')
const {expandPermissions}=require('../src/config/permissionDeps')
const {permissions}=require('../scripts/register-appointments-permissions')
const scope={companyId:'company',branchId:'branch',branchIds:['branch'],userId:'user',isAdmin:false,permissions:['appointments.view','appointments.collect','receivables.manage']}
test('commercial Agenda permissions are registered without granting broader financial write powers',()=>{
  for(const code of ['appointments.collect','appointments.refund','appointments.issue_sale'])assert.ok(permissions.some(p=>p.code===code),code)
  for(const [action,write] of [['collect','receivables.manage'],['refund','receivables.manage'],['issue_sale','sales.create']]){
    const effective=expandPermissions([`appointments.${action}`])
    assert.ok(effective.includes('appointments.view'));assert.ok(!effective.includes(write))
  }
})
test('collection requires both independent permissions and enabled finance even for direct callers',async()=>{
  let disabled
  const db={companyModule:{findMany:async()=>[{module_code:'appointments',status:'ACTIVE'},...(disabled?[{module_code:disabled,status:'DISABLED'}]:[])]}}
  await assertCommercialAccess(db,scope,'collect')
  for(const permissions of [['appointments.collect'],['receivables.manage'],['appointments.view']])await assert.rejects(()=>assertCommercialAccess(db,{...scope,permissions},'collect'),{status:403})
  for(disabled of ['appointments','receivables','sales','contacts'])await assert.rejects(()=>assertCommercialAccess(db,scope,'collect'),{code:'MODULE_DISABLED'})
  await assert.rejects(()=>assertCommercialAccess(db,{...scope,branchId:null},'collect'),{code:'BRANCH_REQUIRED'})
})
