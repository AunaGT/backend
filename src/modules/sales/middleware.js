function requirePromotionsForSale(req, res, next) {
  const codes = req.body?.promotion_codes
  if (!Array.isArray(codes) || !codes.some((code) => String(code || '').trim())) return next()

  const module = req.companyModules?.find((item) => item.code === 'promotions')
  if (module?.effectiveEnabled) return next()

  return res.status(403).json({
    code: 'MODULE_DISABLED',
    message: `El módulo ${module?.name || 'promotions'} no está disponible para esta empresa`,
    module: 'promotions',
    status: module?.status || 'DISABLED',
    blockedBy: module?.blockedBy || [],
  })
}

module.exports = { requirePromotionsForSale }
