const { getCompanyModuleBlock } = require('../platform/service')

function getUnavailableModule(modules, code) {
  const module = modules?.find((item) => item.code === code)
  if (module?.effectiveEnabled) return null
  return {
    code: 'MODULE_DISABLED',
    message: `El módulo ${module?.name || code} no está disponible para esta empresa`,
    module: code,
    status: module?.status || 'DISABLED',
    blockedBy: module?.blockedBy || [],
  }
}

function requireOrdersForConversion(req, res, next) {
  const block = getUnavailableModule(req.companyModules, 'orders')
  if (block) return res.status(403).json(block)
  next()
}

module.exports = {
  getCompanyModuleBlock,
  getUnavailableModule,
  requireOrdersForConversion,
}
