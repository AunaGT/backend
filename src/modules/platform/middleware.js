const { getModuleDefinition } = require('./registry')
const { readCompanyModules } = require('./service')

function requireModule(code) {
  if (!getModuleDefinition(code)) throw new Error(`No se puede montar un módulo desconocido: ${code}`)

  return async (req, res, next) => {
    try {
      // La autenticación granular vive dentro de cada router. Si todavía no hay
      // sesión dejamos que su middleware produzca el 401 habitual.
      if (!req.user) return next()
      if (!req.companyId) {
        return res.status(400).json({
          code: 'MODULE_CONTEXT_REQUIRED',
          message: 'Selecciona una empresa para acceder al módulo',
        })
      }

      const modules = await readCompanyModules(req.companyId)
      const module = modules.find((item) => item.code === code)
      if (!module?.effectiveEnabled) {
        return res.status(403).json({
          code: 'MODULE_DISABLED',
          message: `El módulo ${module?.name || code} no está disponible para esta empresa`,
          module: code,
          status: module?.status || 'DISABLED',
          blockedBy: module?.blockedBy || [],
        })
      }
      req.companyModules = modules
      req.companyModule = module
      next()
    } catch (error) {
      next(error)
    }
  }
}

function requireAnyModule(...codes) {
  for (const code of codes) {
    if (!getModuleDefinition(code)) throw new Error(`No se puede montar un módulo desconocido: ${code}`)
  }

  return async (req, res, next) => {
    try {
      if (!req.user) return next()
      if (!req.companyId) {
        return res.status(400).json({
          code: 'MODULE_CONTEXT_REQUIRED',
          message: 'Selecciona una empresa para acceder al módulo',
        })
      }
      const modules = await readCompanyModules(req.companyId)
      const available = modules.find((item) => codes.includes(item.code) && item.effectiveEnabled)
      if (!available) {
        return res.status(403).json({
          code: 'MODULE_DISABLED',
          message: 'Ninguno de los módulos requeridos está disponible para esta empresa',
          modules: codes,
        })
      }
      req.companyModule = available
      next()
    } catch (error) {
      next(error)
    }
  }
}

module.exports = { requireAnyModule, requireModule }
