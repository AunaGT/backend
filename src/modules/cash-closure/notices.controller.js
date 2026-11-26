const { prisma } = require('../../models/prisma')
const { noticeScope } = require('./notices.access')
const service = require('./notices'), evidence = require('./noticeEvidence')
const run = action => async (req, res, next) => {
  try { res.set('Cache-Control', 'private, no-store'); await action(req, res) } catch (error) { next(error) }
}
const write = fn => prisma.$transaction(fn, { timeout: 20000 })
const sent = (res, result) => res.status(result.replayed ? 200 : 201).json(result)
exports.capabilities = run(async (req, res) => {
  const s = noticeScope(req, 'capabilities'), available = await service.noticesAvailable(prisma)
  res.json({ available, canView: s.canView, canCreate: s.canCreate, canConfirm: s.canConfirm, evidenceUpload: available && s.canConfirm && await evidence.evidenceAvailable() })
})
exports.list = run(async (req, res) => res.json(await service.listNotices(prisma, noticeScope(req, 'view'), req.query)))
exports.detail = run(async (req, res) => res.json(await service.getNotice(prisma, noticeScope(req, 'view'), req.params.noticeId)))
exports.periods = run(async (req, res) => res.json(await service.confirmPeriods(prisma, noticeScope(req, 'confirm'))))
exports.create = run(async (req, res) => { const s = noticeScope(req, 'create'); sent(res, await write(tx => service.createNotice(tx, s, req.body))) })
exports.confirm = run(async (req, res) => { const s = noticeScope(req, 'confirm'); sent(res, await write(tx => service.confirmNotice(tx, s, req.params.noticeId, req.body))) })
exports.reject = run(async (req, res) => { const s = noticeScope(req, 'confirm'); sent(res, await write(tx => service.rejectNotice(tx, s, req.params.noticeId, req.body))) })
exports.uploadEvidence = run(async (req, res) => { const s = noticeScope(req, 'confirm'); res.status(201).json(await evidence.uploadEvidence(s.companyId, req.file)) })
exports.evidence = run(async (req, res) => {
  const s = noticeScope(req, 'confirm'), notice = await service.getNotice(prisma, s, req.params.noticeId)
  res.json(await evidence.signEvidence(s.companyId, notice.evidence_path))
})
