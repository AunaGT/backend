const { prisma } = require('../../models/prisma')
const { hasPerm,requireBranch,requireCompany } = require('../../middlewares/tenant')
const { isSystemAdmin } = require('../users/roles/policy')
exports.view = async (req,res,next) => {
  try {
    if (!req.user?.sub || req.integrationCredential || req.integration) throw Object.assign(new Error('Inicia sesión para consultar tu turno'),{status:401})
    const can = (...codes) => codes.some(c=>hasPerm(req.user,c))
    const canOperate = can('sales.create','cashclosure.create','cashclosure.create_day','cashclosure.create_own')
    const canJoin = canOperate || can(...require('../../services/cashSharedSessions').operationPermissions)
    if (!canJoin && !require('./readAccess').readCapabilities(req).viewOwn) throw Object.assign(new Error('No tienes acceso a turnos de caja'),{status:403})
    const scope = { companyId:requireCompany(req),branchId:requireBranch(req),userId:req.user.sub,isAdmin:isSystemAdmin(req.user.role),canOperate,canJoin,
      canManageTeam:can('cashclosure.create','cashclosure.create_day'),canDeclare:can('cashclosure.create','cashclosure.create_own'),
      canCreateMovement:can('cash.movements.create_own','cash.movements.create_team'),canHandoverOwn:can('cash.transfers.operate_own'),canHandoverTeam:can('cash.transfers.operate_team') }
    res.set('Cache-Control','private, no-store')
    res.json(await require('./myTurns').myTurns(prisma,scope,req.query.sessionId))
  } catch (error) { next(error) }
}
