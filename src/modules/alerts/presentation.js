const { DateTime } = require('luxon')

exports.formatAlertTimestamp = (date) => {
  if (!date) return { timestamp: '', localDate: '', timestampIso: '' }
  const local = DateTime.fromJSDate(date, { zone: 'utc' }).setZone('America/Guatemala').setLocale('es')
  return { timestamp: local.toFormat('dd LLL yyyy HH:mm'), localDate: local.toISODate(), timestampIso: date.toISOString() }
}
