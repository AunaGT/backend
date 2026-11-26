const {SCOPES,requiredReadScope,fail}=require('./credentials')
const {credentialUnavailable}=require('./credentialState')
const {performance}=require('node:perf_hooks')
const {permissions,isActiveMembership}=require('../../services/userAccess')
const {isSystemAdmin}=require('../users/roles/policy')
const {resolveEffectiveModules}=require('../platform/registry')
const requirements=Object.freeze({
 'products.read':['products.view'],'categories.read':['products.view'],'prices.read':['products.view'],'availability.read':['products.view','warehouses.view'],
 'quotes.read':['quotes.view'],'quotes.create_draft':['quotes.create','products.view','contacts.clients.view'],
 'quotes.update_draft':['quotes.view','quotes.create','products.view','contacts.clients.view'],'quotes.cancel_draft':['quotes.view','quotes.manage'],
 'orders.read':['orders.view'],'orders.create_draft':['orders.create','products.view','contacts.clients.view'],
 'orders.update_draft':['orders.view','orders.create','products.view','contacts.clients.view'],'orders.cancel_draft':['orders.view','orders.manage'],'customers.create':['contacts.clients.create']
})
const scopeModule=s=>s.startsWith('quotes.')?'quotes':s.startsWith('orders.')?'orders':s==='customers.create'?'contacts':'inventory'
async function loadIntegrationPrincipal(db,{companyId,ownerId},now=new Date()){
 const membership=await db.userCompany.findUnique({where:{user_id_company_id:{user_id:ownerId,company_id:companyId}},select:{status:true,company:{select:{active:true}},role:{include:{permissions:{include:{permission:true}}}},user:{select:{name:true,role:{include:{permissions:{include:{permission:true}}}}}}}})
 if(!membership||!isActiveMembership(membership))fail(401,'INVALID_KEY')
 const role=membership.role||membership.user?.role
 if(!role||role.company_id&&role.company_id!==companyId)fail(401,'INVALID_KEY')
 const [assigned,modules,settings]=await Promise.all([
  db.userBranch.findMany({where:{user_id:ownerId,branch:{company_id:companyId,active:true}},select:{branch:{select:{id:true,name:true,company_id:true,active:true}}}}),
  db.companyModule.findMany({where:{company_id:companyId}}),
  db.systemSetting.findMany({where:{company_id:companyId,key:{in:['inventory_services_enabled','inventory_units_enabled','currency_code']}},select:{key:true,value:true}})
 ])
 const config=Object.fromEntries(settings.map(r=>[r.key,r.value])),enabledModules=resolveEffectiveModules(modules,now).filter(m=>m.effectiveEnabled).map(m=>m.code)
 return {name:membership.user?.name||'',permissions:permissions(role),isAdmin:isSystemAdmin(role),branches:assigned.map(r=>r.branch).filter(b=>b.active&&b.company_id===companyId).map(({id,name})=>({id,name})),enabledModules,inventoryEnabled:enabledModules.includes('inventory'),servicesEnabled:config.inventory_services_enabled==='true',unitsEnabled:config.inventory_units_enabled==='true',currency:/^[A-Z]{3}$/.test(config.currency_code||'')?config.currency_code:'GTQ'}
}
function effectiveScopes(principal,granted){
 const effective=granted.filter(s=>SCOPES.includes(s)&&(scopeModule(s)==='inventory'?principal.inventoryEnabled:principal.enabledModules?.includes(scopeModule(s)))&&(principal.isAdmin||requirements[s].every(p=>principal.permissions.includes(p))))
 return effective.filter(s=>!requiredReadScope(s)||effective.includes(requiredReadScope(s)))
}
function integrationContext(row,principal){
 const scopes=effectiveScopes(principal,row.scopes),branches=principal.branches.filter(b=>row.branches.some(r=>r.branch_id===b.id))
 if(!scopes.length||!branches.length)fail(403,'FORBIDDEN')
 return{credentialId:row.id,companyId:row.company_id,integrationId:row.integration_id,ownerId:row.owner_id,customerPolicy:row.customer_policy,customerPaymentTermId:row.customer_payment_term_id,scopes,branches,servicesEnabled:principal.servicesEnabled,unitsEnabled:principal.unitsEnabled,currency:principal.currency}
}
async function revalidateDocumentContext(tx,context,type,action,branchId,now=new Date(),{lockCredential=false}={}){
 const started=performance.now(),checkedNow=()=>new Date(now.getTime()+Math.floor(performance.now()-started))
 if(lockCredential)await tx.$executeRaw`SELECT id FROM integration_credentials WHERE id=${context.credentialId}::uuid AND company_id=${context.companyId}::uuid FOR UPDATE`
 const row=await tx.integrationCredential.findFirst({where:{id:context.credentialId,company_id:context.companyId},include:{branches:{select:{branch_id:true}}}})
 if(credentialUnavailable(row,checkedNow()))fail(401,'INVALID_KEY')
 const actionScope={CREATE_DRAFT:'create_draft',UPDATE_DRAFT:'update_draft',CANCEL_DRAFT:'cancel_draft'}[action]
 if(!row.integration_id||row.integration_id!==context.integrationId||!['QUOTE','ORDER'].includes(type)||!actionScope)fail(403,'FORBIDDEN')
 const fresh=integrationContext(row,await loadIntegrationPrincipal(tx,{companyId:row.company_id,ownerId:row.owner_id},checkedNow()))
 if(credentialUnavailable(row,checkedNow()))fail(401,'INVALID_KEY')
 if(!fresh.scopes.includes((type==='QUOTE'?'quotes.':'orders.')+actionScope)||branchId!==null&&!fresh.branches.some(b=>b.id===branchId))fail(403,'FORBIDDEN')
 return fresh
}
function revalidateDraftContext(tx,context,type,branchId,now=new Date(),options={}){return revalidateDocumentContext(tx,context,type,'CREATE_DRAFT',branchId,now,options)}
function assertScopeAccess(principal,scopes,branchIds){if(effectiveScopes(principal,scopes).length!==scopes.length||branchIds.some(id=>!principal.branches.some(b=>b.id===id)))fail(403,'FORBIDDEN')}
function authorizeManagement(scope,action='view'){
 if(!scope?.companyId||!scope.actorId)fail(403,'FORBIDDEN')
 if(!scope.isAdmin&&!scope.permissions?.includes('integrations.'+action)&&!(action==='view'&&scope.permissions?.includes('integrations.manage')))fail(403,'FORBIDDEN')
 if(action==='manage'&&scope.branchId==='all')fail(403,'FORBIDDEN')
}
module.exports={loadIntegrationPrincipal,effectiveScopes,assertScopeAccess,authorizeManagement,integrationContext,revalidateDraftContext,revalidateDocumentContext}
