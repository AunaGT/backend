function enabledModuleCodes(modules = []) {
  return new Set(
    modules
      .filter((module) => module?.effectiveEnabled)
      .map((module) => String(module.code))
  )
}

function resolveAnalyticsSections(modules = []) {
  const enabled = enabledModuleCodes(modules)
  const sales = enabled.has('sales')
  const inventory = enabled.has('inventory')

  return {
    sales,
    products: sales && inventory,
    inventory,
    purchases: enabled.has('merchandise'),
    receivables: enabled.has('receivables'),
  }
}

module.exports = { resolveAnalyticsSections }
