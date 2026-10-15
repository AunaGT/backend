const { hasPerm, requireCompany } = require('../../middlewares/tenant')
const { resolveEffectiveModules } = require('../platform/registry')
const { assertServicesEnabled } = require('../../services/catalogItemRules')
const { fail } = require('./domain/validation')

function hasAgendaPermission(scope, code) { return scope.isAdmin || scope.permissions.includes(code) }
function requestScope(req) {
  if (!req.user?.sub) fail(401, 'UNAUTHENTICATED', 'Inicia sesión para acceder a Agenda')
  const companyId = requireCompany(req)
  if (!hasPerm(req.user, 'appointments.view')) fail(403, 'FORBIDDEN', 'No tienes permiso para consultar Agenda')
  return { companyId, branchId: req.branchId || null, branchIds: req.branchId ? [...(req.userBranchIds || [req.branchId])] : [...(req.branchIds || [])],
    userId: req.user.sub, permissions: [...(req.user.permissions || [])], isAdmin: hasPerm({ ...req.user, permissions: [] }, 'appointments.view') }
}
function assertAgendaWrite(scope) {
  if (!scope.branchId) fail(400, 'BRANCH_REQUIRED', 'Selecciona una sucursal; la vista consolidada es solo de consulta')
}
function appointmentWhere(scope) {
  const where = { company_id: scope.companyId, branch_id: scope.branchId || { in: scope.branchIds } }
  if (!hasAgendaPermission(scope, 'appointments.view_team')) {
    where.OR = [
      {providers:{some:{provider:{OR:[{user_id:scope.userId},{employee:{user_id:scope.userId}}]}}}},
      {record_type:'ACTIVITY',created_by:scope.userId},
      {record_type:'ACTIVITY',organizer_id:scope.userId},
      {record_type:'ACTIVITY',participants:{some:{kind:'USER',user_id:scope.userId}}},
      {record_type:'SCHEDULED_SERVICE',created_by:scope.userId,providers:{none:{}}},
    ]
  }
  return where
}
async function assertAppointmentsEnabled(db, scope) {
  const rows = await db.companyModule.findMany({ where: { company_id: scope.companyId } })
  if (!resolveEffectiveModules(rows).find(item => item.code === 'appointments')?.effectiveEnabled) {
    fail(403, 'MODULE_DISABLED', 'Agenda no está habilitada para esta empresa')
  }
}
async function agendaCapabilities(db, scope) {
  const modules=resolveEffectiveModules(await db.companyModule.findMany({where:{company_id:scope.companyId}}))
  const enabled=code=>!!modules.find(item=>item.code===code)?.effectiveEnabled
  let catalog=false
  if(enabled('inventory')) {
    const setting=await db.systemSetting.findUnique({where:{company_id_key:{company_id:scope.companyId,key:'inventory_services_enabled'}}})
    catalog=String(setting?.value??'false').toLowerCase()==='true'
  }
  return {catalog,contacts:enabled('contacts'),hr:enabled('hr')}
}
async function assertCatalogIntegration(db,scope) {
  if(!hasAgendaPermission(scope,'products.view')) fail(403,'CATALOG_FORBIDDEN','Necesitas permiso para consultar el catálogo de servicios')
  const modules=resolveEffectiveModules(await db.companyModule.findMany({where:{company_id:scope.companyId}}))
  if(!modules.find(item=>item.code==='inventory')?.effectiveEnabled) fail(403,'CATALOG_DISABLED','El catálogo está deshabilitado para esta empresa')
  await assertServicesEnabled(db,scope.companyId)
}
async function assertContactsIntegration(db,scope) {
  if(!hasAgendaPermission(scope,'contacts.clients.view')) fail(403,'CONTACTS_FORBIDDEN','Necesitas permiso para consultar contactos')
  const modules=resolveEffectiveModules(await db.companyModule.findMany({where:{company_id:scope.companyId}}))
  if(!modules.find(item=>item.code==='contacts')?.effectiveEnabled) fail(403,'CONTACTS_DISABLED','Contactos está deshabilitado para esta empresa')
}
async function assertCommercialAccess(db,scope,action){
  assertAgendaWrite(scope)
  const extra=action==='issue_sale'?'sales.create':'receivables.manage'
  if(!hasAgendaPermission(scope,`appointments.${action}`)||!hasAgendaPermission(scope,extra))fail(403,'FORBIDDEN','No tienes permiso financiero para esta acción')
  const modules=resolveEffectiveModules(await db.companyModule.findMany({where:{company_id:scope.companyId}}))
  for(const code of ['appointments','receivables','sales'])if(!modules.find(m=>m.code===code)?.effectiveEnabled)fail(403,'MODULE_DISABLED','Agenda, Cartera y Ventas deben estar habilitados para gestionar los cobros')
}
module.exports = { requestScope, appointmentWhere, assertAgendaWrite, assertAppointmentsEnabled, hasAgendaPermission,
  agendaCapabilities,assertCatalogIntegration,assertContactsIntegration,assertCommercialAccess }
