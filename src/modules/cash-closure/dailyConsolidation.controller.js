const { prisma } = require('../../models/prisma')
const { dailyScope } = require('./dailyConsolidation.access')
const service = require('./dailyConsolidation')
const run = action => async (req, res, next) => {
  try { res.set('Cache-Control', 'private, no-store'); await action(req, res) } catch (error) { next(error) }
}
exports.view = run(async (req, res) => {
  const s = dailyScope(req, 'view')
  res.json({ ...await service.dayView(prisma, s, req.params.date), canFinalize: s.canFinalize })
})
exports.finalize = run(async (req, res) => {
  const s = dailyScope(req, 'finalize'), result = await prisma.$transaction(tx => service.finalizeDay(tx, s, req.params.date, req.body || {}), { timeout: 30000 })
  res.status(result.replayed ? 200 : 201).json(result)
})
