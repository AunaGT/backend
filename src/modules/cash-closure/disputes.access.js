const {hasPerm}=require('../../middlewares/tenant')
const {isSystemAdmin}=require('../users/roles/policy')
const {validId}=require('./disputes.boundary')
const {fail}=require('./disputes.domain')

function disputeScope(req,action) {
  if (!req.user?.sub || req.integrationCredential || req.integration) fail('DISPUTE_SESSION_REQUIRED','Inicia sesión para gestionar disputas',401)
  const concrete=validId(req.branchId)
  const branches=concrete?[req.branchId]:req.branchIds
  if (![req.companyId,req.user.sub].every(validId) || !Array.isArray(branches) || !branches.length || !branches.every(validId)) {
    fail('DISPUTE_SCOPE_REQUIRED','Selecciona una empresa y sucursal autorizadas',403)
  }
  const isAdmin=isSystemAdmin(req.user.role),has=code=>isAdmin||hasPerm(req.user,code)
  const manage=has('cash.disputes.manage'),movements=has('cash.disputes.movements'),resolve=has('cash.disputes.resolve')
  const charge=has('cash.disputes.charge_customer')
  const can={read:has('cash.disputes.view')||manage||movements||resolve||charge,
    manage:concrete&&manage,movements:concrete&&movements,resolve:concrete&&resolve,
    charge:concrete&&resolve&&charge,adjust:concrete&&resolve&&has('receivables.adjust'),post:concrete&&has('accounting.create'),policy:concrete&&isAdmin&&has('cash.policies.manage')}
  if (action!=='capabilities' && !can[action]) fail('DISPUTE_FORBIDDEN','No tienes permiso para esta acción de disputas',403)
  return {companyId:req.companyId.toLowerCase(),branchId:concrete?req.branchId.toLowerCase():null,branchIds:[...new Set(branches.map(id=>id.toLowerCase()))],userId:req.user.sub.toLowerCase(),isAdmin,can}
}
module.exports={disputeScope}
