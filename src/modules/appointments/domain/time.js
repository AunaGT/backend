const { DateTime } = require('luxon')
const { fail } = require('./validation')

function localChoices(local, zone) {
  const value = DateTime.fromISO(local, { zone })
  if (!value.isValid || value.toFormat("yyyy-MM-dd'T'HH:mm") !== local) return []
  return value.getPossibleOffsets()
}
function resolveLocal(local, zone, offsetMinutes) {
  const choices = localChoices(local, zone)
  if (!choices.length) fail(400, 'INVALID_LOCAL_TIME', 'La hora no existe en esa zona')
  if (choices.length > 1 && offsetMinutes === undefined) fail(400, 'AMBIGUOUS_LOCAL_TIME', 'La hora es ambigua; elige su desplazamiento')
  const selected = offsetMinutes === undefined ? choices[0] : choices.find(item => item.offset === offsetMinutes)
  if (!selected) fail(400, 'INVALID_OFFSET', 'El desplazamiento no coincide con la hora')
  return selected.toUTC().toISO()
}
module.exports = { resolveLocal, localChoices }
