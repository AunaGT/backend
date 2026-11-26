const { prisma } = require('../../models/prisma')
const { reviewScope } = require('./reviewFlow.access')
const flow = require('./reviewFlow'), policy = require('./policy')
const run = action => async (req, res, next) => {
  try { res.set('Cache-Control', 'private, no-store'); await action(req, res) } catch (error) { next(error) }
}
const write = fn => prisma.$transaction(fn, { timeout: 20000 })
exports.capabilities = run(async (req, res) => {
  const s = reviewScope(req, 'capabilities')
  res.json({ available: await policy.reviewAvailable(prisma), canReview: s.canReview, canManagePolicy: s.canManagePolicy, canDeclare: s.canDeclare, isAdmin: s.isAdmin })
})
exports.policy = run(async (req, res) => {
  const s = reviewScope(req, 'capabilities')
  if (!s.canManagePolicy && !s.canReview) reviewScope(req, 'policy')
  res.json(await policy.readPolicies(prisma, s))
})
exports.savePolicy = run(async (req, res) => { const s = reviewScope(req, 'policy'); res.json(await write(tx => policy.savePolicy(tx, s, req.body || {}))) })
exports.review = run(async (req, res) => res.json(await flow.reviewContext(prisma, reviewScope(req, 'capabilities'), req.params.id)))
exports.sessionState = run(async (req, res) => res.json(await flow.sessionState(prisma, reviewScope(req, 'capabilities'), req.params.sessionId)))
exports.recount = run(async (req, res) => { const s = reviewScope(req, 'review'); res.json(await write(tx => flow.requestRecount(tx, s, req.params.id, req.body || {}))) })
exports.finalize = run(async (req, res) => { const s = reviewScope(req, 'review'); res.json(await write(tx => flow.finalize(tx, s, req.params.id, req.body || {}))) })
