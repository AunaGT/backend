const { prisma } = require('../../models/prisma')
const { physicalMovementScope } = require('./physicalMovements.access')
const service = require('./physicalMovements')
const run = action => async (req,res,next) => {
  try { res.set('Cache-Control','private, no-store'); await action(req,res) } catch(error) { next(error) }
}
exports.capabilities = run(async(req,res)=>{
  const scope=physicalMovementScope(req,'capabilities')
  res.json({available:await service.physicalMovementsAvailable(prisma),canViewOwn:scope.canViewOwn,canViewTeam:scope.canViewTeam,canCreateOwn:scope.canCreateOwn,canCreateTeam:scope.canCreateTeam,canCorrect:scope.canCorrect})
})
exports.list=run(async(req,res)=>res.json(await service.listPhysicalMovements(prisma,physicalMovementScope(req,'view'),req.query)))
exports.detail=run(async(req,res)=>res.json(await service.getPhysicalMovement(prisma,physicalMovementScope(req,'view'),req.params.movementId)))
exports.options=run(async(req,res)=>{
  const scope=physicalMovementScope(req,'capabilities')
  if(!scope.canCreateOwn&&!scope.canCreateTeam&&!scope.canCorrect)throw Object.assign(new Error('No tienes permiso para registrar efectivo'),{status:403})
  res.json(await service.physicalMovementOptions(prisma,scope))
})
exports.create=run(async(req,res)=>{
  const scope=physicalMovementScope(req,'create')
  const receipt=await prisma.$transaction(tx=>service.createPhysicalMovement(tx,scope,req.body),{timeout:20000})
  res.status(receipt.replayed?200:201).json(receipt)
})
exports.correct=run(async(req,res)=>{
  const scope=physicalMovementScope(req,'correct')
  const receipt=await prisma.$transaction(tx=>service.correctPhysicalMovement(tx,scope,req.params.movementId,req.body),{timeout:20000})
  res.status(receipt.replayed?200:201).json(receipt)
})
