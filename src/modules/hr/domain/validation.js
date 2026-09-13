/** Error de negocio con status HTTP; lo traduce el error handler global. */
function fail(status, message) {
  const err = new Error(message)
  err.status = status
  throw err
}

/** Interpreta yyyy-mm-dd al mediodía de Guatemala para evitar cambios de día. */
function toDate(value, field, { required = false } = {}) {
  if (value == null || String(value).trim() === '') {
    if (required) fail(400, `${field} es obligatorio`)
    return null
  }
  const raw = String(value).trim()
  const date = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? new Date(`${raw}T12:00:00-06:00`) : new Date(raw)
  if (Number.isNaN(date.getTime())) fail(400, `${field} no es una fecha válida`)
  return date
}

function toMoney(value, field, { required = false, min = 0 } = {}) {
  if (value == null || String(value).trim() === '') {
    if (required) fail(400, `${field} es obligatorio`)
    return null
  }
  const n = Number(value)
  if (!Number.isFinite(n) || n < min) fail(400, `${field} debe ser un número mayor o igual a ${min}`)
  return Math.round(n * 100) / 100
}

const trim = (value, max) => (
  value == null || String(value).trim() === '' ? null : String(value).trim().slice(0, max)
)

function toEnum(value, allowed, message) {
  const raw = value == null ? '' : String(value).trim().toUpperCase()
  if (!allowed.includes(raw)) fail(400, message)
  return raw
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function toUuid(value, message) {
  const raw = value == null ? '' : String(value).trim()
  if (!UUID_RE.test(raw)) fail(404, message)
  return raw
}

module.exports = { fail, toDate, toMoney, trim, toEnum, toUuid }
