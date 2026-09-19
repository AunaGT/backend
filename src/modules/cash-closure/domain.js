const CASH_DIFFERENCE_EPSILON = 0.005

function normalizeClosureNotes(notes) {
  return typeof notes === 'string' ? notes.trim() : ''
}

function requiresDifferenceReason(difference, notes) {
  return Math.abs(Number(difference) || 0) >= CASH_DIFFERENCE_EPSILON && !normalizeClosureNotes(notes)
}

module.exports = {
  CASH_DIFFERENCE_EPSILON,
  normalizeClosureNotes,
  requiresDifferenceReason,
}
