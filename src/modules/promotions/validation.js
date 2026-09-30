const { DateTime } = require('luxon')

function parsePromotionDate(value, isEnd = false) {
  if (value == null || value === '') return null
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const date = DateTime.fromISO(value, { zone: 'America/Guatemala' })
    return date.isValid ? (isEnd ? date.endOf('day') : date.startOf('day')).toJSDate() : undefined
  }
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date
}

function validatePromotionDates(start, end) {
  const startDate = parsePromotionDate(start)
  const endDate = parsePromotionDate(end, true)
  if (startDate === undefined) return 'Fecha de inicio no válida'
  if (endDate === undefined) return 'Fecha de fin no válida'
  if (startDate && endDate && endDate < startDate) return 'La fecha de fin debe ser posterior o igual a la fecha de inicio'
  return null
}

module.exports = { validatePromotionDates, parsePromotionDate }
