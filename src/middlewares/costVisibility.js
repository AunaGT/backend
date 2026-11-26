const { hasPerm } = require('./tenant')

const derivedValues = new Set(['valueDeltaApprox', 'valueDifference', 'inventoryValue', 'inventory_value', 'stock_value', 'value_at_cost', 'reorderGapValue'])
function projectCosts(value) {
  if (Array.isArray(value)) return value.map(projectCosts)
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return value
  const costRecord = Object.keys(value).some(key => /cost/i.test(key)) || Object.hasOwn(value, 'assembly_group_id')
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/cost|margin|profit|valuation/i.test(key) && !derivedValues.has(key) && !(key === 'value' && costRecord))
    .map(([key, item]) => [key, projectCosts(item)]))
}

function protectCostResponses(req, res, next) {
  const json = res.json
  res.json = function (body) {
    this.setHeader('Cache-Control', 'private, no-store')
    return json.call(this, hasPerm(req.user, 'products.view_costs') ? body : projectCosts(body))
  }
  next()
}

module.exports = { projectCosts, protectCostResponses }
