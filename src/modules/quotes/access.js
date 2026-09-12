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

async function getCompanyModuleBlock(companyId, code, loadModules = readCompanyModules) {
  const modules = await loadModules(companyId, undefined, { useCache: false })
  return getUnavailableModule(modules, code)
}

module.exports = {
  getCompanyModuleBlock,
  getUnavailableModule,
  requireOrdersForConversion,
}
const { readCompanyModules } = require('../platform/service')
