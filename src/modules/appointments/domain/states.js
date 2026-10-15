const { fail } = require('./validation')

const bookingTransitions = {
  HELD: { CONFIRM: 'CONFIRMED', CANCEL: 'CANCELLED' },
  PENDING: { CONFIRM: 'CONFIRMED', CANCEL: 'CANCELLED' },
  CONFIRMED: { ARRIVE: 'ARRIVED', NO_SHOW: 'NO_SHOW', CANCEL: 'CANCELLED' },
  ARRIVED: { START: 'IN_SERVICE', CANCEL: 'CANCELLED' },
  IN_SERVICE: { COMPLETE: 'COMPLETED', CANCEL: 'CANCELLED' },
}
const sessionTransitions = {
  SCHEDULED: { START: 'IN_PROGRESS', CANCEL: 'CANCELLED' },
  IN_PROGRESS: { COMPLETE: 'COMPLETED', CANCEL: 'CANCELLED' },
}
function transition(map, status, action) {
  const next = map[status]?.[action]
  if (!next) fail(409, 'INVALID_TRANSITION', 'Esta acción no está disponible en el estado actual')
  return next
}
function nextBookingState(status, action) { return transition(bookingTransitions, status, action) }
function nextSessionState(status, action) { return transition(sessionTransitions, status, action) }
function occupiesSeat(booking, now) {
  if (['CONFIRMED', 'ARRIVED', 'IN_SERVICE'].includes(booking.status)) return true
  if (!['HELD', 'PENDING'].includes(booking.status)) return false
  const expiry = booking.expires_at ?? booking.expiresAt
  return expiry != null && new Date(expiry).getTime() > now.getTime()
}
module.exports = { nextBookingState, nextSessionState, occupiesSeat }
