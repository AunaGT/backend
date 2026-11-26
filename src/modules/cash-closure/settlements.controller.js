const { prisma } = require('../../models/prisma')
const { settlementScope } = require('./settlements.access')
const methods = require('./bankMethods'), service = require('./settlements')
const run = action => async (req, res, next) => {
  try { res.set('Cache-Control', 'private, no-store'); await action(req, res) } catch (error) { next(error) }
}
const write = fn => prisma.$transaction(fn, { timeout: 30000 })
const sent = (res, result) => res.status(result.replayed ? 200 : 201).json(result)
exports.capabilities = run(async (req, res) => {
  const s = settlementScope(req, 'capabilities')
  res.json({ available: await service.settlementsAvailable(prisma), canManage: s.canManage, canApprove: s.isAdmin, canSettle: s.canSettle })
})
// Leer la configuración: quien propone o quien liquida (necesita saber qué medios son diferidos).
exports.methods = run(async (req, res) => {
  const s = settlementScope(req, 'capabilities')
  if (!s.canManage && !s.canSettle) settlementScope(req, 'methods')
  res.json(await methods.listBankMethods(prisma, s))
})
exports.accounts = run(async (req, res) => {
  const s = settlementScope(req, 'capabilities')
  if (!s.canManage && !s.canSettle) settlementScope(req, 'methods')
  res.json(await methods.bankMethodAccounts(prisma, s))
})
exports.propose = run(async (req, res) => { const s = settlementScope(req, 'methods'); res.status(201).json(await write(tx => methods.proposeBankMethod(tx, s, req.body || {}))) })
// Aprobar y rechazar: solo el admin canónico, comprobado también en el servicio.
exports.approve = run(async (req, res) => { const s = settlementScope(req, 'capabilities'); res.json(await write(tx => methods.approveBankMethod(tx, s, req.params.versionId))) })
exports.reject = run(async (req, res) => { const s = settlementScope(req, 'capabilities'); res.json(await write(tx => methods.rejectBankMethod(tx, s, req.params.versionId, req.body || {}))) })
exports.withdraw = run(async (req, res) => { const s = settlementScope(req, 'methods'); res.json(await write(tx => methods.withdrawProposal(tx, s, req.params.versionId))) })
exports.pending = run(async (req, res) => res.json(await service.pendingReceipts(prisma, settlementScope(req, 'settlements'), req.query)))
exports.list = run(async (req, res) => res.json(await service.listSettlements(prisma, settlementScope(req, 'settlements'), req.query)))
exports.detail = run(async (req, res) => res.json(await service.getSettlement(prisma, settlementScope(req, 'settlements'), req.params.settlementId)))
exports.create = run(async (req, res) => { const s = settlementScope(req, 'settlements'); sent(res, await write(tx => service.createSettlement(tx, s, req.body || {}))) })
exports.void = run(async (req, res) => { const s = settlementScope(req, 'settlements'); sent(res, await write(tx => service.voidSettlement(tx, s, req.params.settlementId, req.body || {}))) })
exports.deposit = run(async (req, res) => {
  const s = settlementScope(req, 'settlements')
  res.json(req.query.reference ? await service.findDeposit(prisma, s, req.query) : await service.getDeposit(prisma, s, req.params.depositId))
})
