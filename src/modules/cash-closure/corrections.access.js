const { hasPerm } = require('../../middlewares/tenant')
const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i
const fail = (status,message) => { throw Object.assign(new Error(message),{status}) }
function correctionScope(req, action) {
  if (!req.user?.sub || req.integrationCredential || req.integration) fail(401,'Inicia sesión para consultar correcciones')
  const branchIds=req.branchId&&req.branchId!=='all'?[req.branchId]:req.branchIds,concrete=typeof req.branchId==='string'&&uuid.test(req.branchId)
  if (![req.companyId,req.user.sub].every(v=>typeof v==='string'&&uuid.test(v))||!Array.isArray(branchIds)||!branchIds.length||!branchIds.every(v=>typeof v==='string'&&uuid.test(v))||action!=='read'&&!concrete) fail(403,'Selecciona una empresa y sucursal')
  const propose=hasPerm(req.user,'cashclosure.correct'),review=['cashclosure.approve','cashclosure.validate'].some(p=>hasPerm(req.user,p))
  const canPropose=concrete&&propose,canReview=concrete&&review
  const viewTeam=propose||review||hasPerm(req.user,'cashclosure.view_team'),viewOwn=viewTeam||hasPerm(req.user,'cashclosure.view')
  if (!({read:viewOwn,propose:canPropose,review:canReview})[action]) fail(403,'No tienes permiso para esta acción de corrección')
  return {companyId:req.companyId,branchId:concrete?req.branchId:null,branchIds:[...new Set(branchIds)],userId:req.user.sub,canPropose,canReview,viewOwn,viewTeam,mode:viewTeam?'team':'mine',canViewHandoverTeam:concrete&&['cash.custody.view','cash.transfers.operate_team'].some(p=>hasPerm(req.user,p)),canViewOwnHandover:concrete&&hasPerm(req.user,'cash.transfers.operate_own')}
}
module.exports={correctionScope}
