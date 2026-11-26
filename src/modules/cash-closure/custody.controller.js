const { prisma } = require('../../models/prisma')
const { custodyScope } = require('./custody.access')
const service = require('./custody')
const run = action => async (req, res, next) => {
  try { res.set('Cache-Control', 'private, no-store'); await action(req, res) } catch (error) { next(error) }
}
const write = fn => prisma.$transaction(fn, { timeout: 20000 })
const sent = (res, result) => res.status(result.replayed ? 200 : 201).json(result)
exports.capabilities = run(async (req, res) => {
  const s = custodyScope(req, 'capabilities')
  res.json({ available: await service.custodyAvailable(prisma), canView: s.canView || s.isAdmin, canManage: s.canManage, canOperateOwn: s.canOperateOwn, canOperateTeam: s.canOperateTeam, canReceive: s.canReceive })
})
exports.custodies = run(async (req, res) => res.json(await service.listCustodies(prisma, custodyScope(req, 'view'))))
exports.createCustody = run(async (req, res) => { const s = custodyScope(req, 'manage'); res.status(201).json(await write(tx => service.createCustody(tx, s, req.body))) })
exports.updateCustody = run(async (req, res) => { const s = custodyScope(req, 'manage'); res.json(await write(tx => service.setCustodyActive(tx, s, req.params.custodyId, req.body))) })
exports.destinations = run(async (req, res) => res.json(await service.destinations(prisma, custodyScope(req, 'view'))))
exports.transfers = run(async (req, res) => res.json(await service.listTransfers(prisma, custodyScope(req, 'view'), req.query)))
exports.transfer = run(async (req, res) => res.json(await service.getTransfer(prisma, custodyScope(req, 'view'), req.params.transferId)))
exports.send = run(async (req, res) => { const s = custodyScope(req, 'send'); sent(res, await write(tx => service.sendTransfer(tx, s, req.body))) })
exports.receive = run(async (req, res) => { const s = custodyScope(req, 'receive'); sent(res, await write(tx => service.receiveTransfer(tx, s, req.params.transferId, req.body))) })
exports.reject = run(async (req, res) => { const s = custodyScope(req, 'receive'); sent(res, await write(tx => service.rejectTransfer(tx, s, req.params.transferId, req.body))) })
exports.pendingHandovers = run(async (req, res) => res.json(await service.pendingHandovers(prisma, custodyScope(req, 'capabilities'))))
exports.handoverContext = run(async (req, res) => res.json(await service.handoverContext(prisma, custodyScope(req, 'view'), req.params.sessionId)))
exports.handover = run(async (req, res) => { const s = custodyScope(req, 'send'); sent(res, await write(tx => service.handoverTurn(tx, s, req.params.sessionId, req.body))) })
// Solo el saldo retenido de una caja de la sucursal: quien abre el turno necesita verlo para contarlo.
exports.registerFloat = run(async (req, res) => res.json(await service.registerFloat(prisma, { companyId: req.companyId, branchId: req.branchId, userId: req.user?.sub }, req.params.registerId)))
