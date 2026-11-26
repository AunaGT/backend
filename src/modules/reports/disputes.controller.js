// Reporte de disputas de cobros digitales: solo en la vista preparada (JSON), con sus PDF/Excel del frontend.
const { prisma } = require('../../models/prisma')
const { getBrandingForPdf } = require('../../utils/pdfBranding')
const { reportError } = require('./reportFilters')
const { assertReportSize } = require('./reportModel')
const { prepareReportMeta, scopeBranchIds } = require('./controller')
const { buildDisputesReport } = require('./models/disputes')

async function disputesReport(req, res, next) {
  try {
    if (String(req.query.format).toLowerCase() !== 'json') throw reportError(400, 'Este reporte se prepara desde la vista de reportes', 'REPORT_FORMAT')
    const branding = await getBrandingForPdf(prisma, req.companyId)
    const meta = await prepareReportMeta(req, branding)
    const rows = await require('../cash-closure/disputes.report').disputeReportRows(prisma, { companyId: req.companyId, branchIds: scopeBranchIds(req),
      start: req.reportPeriod.start, endExclusive: req.reportPeriod.endExclusive })
    assertReportSize(rows?.length || 0)
    res.json(buildDisputesReport({ rows: rows || [], available: rows !== null }, meta))
  } catch (error) { next(error) }
}
module.exports = { disputesReport }
