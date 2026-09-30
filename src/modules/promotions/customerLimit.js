function customerLimitError(limit, customerId, priorUses) {
  if (!limit) return null
  if (!customerId) return 'Esta promoción requiere seleccionar un cliente'
  if (priorUses >= limit) return 'Este cliente alcanzó el límite de usos de la promoción'
  return null
}

module.exports = { customerLimitError }
