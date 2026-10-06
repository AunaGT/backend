const { fail, toUuid } = require('./validation')
function employeeExtras(input) {
  const result = {}
  for (const [key, max] of Object.entries({ gender: 50, marital_status: 50, nationality: 100, workday: 100, work_schedule: 200 })) {
    if (input[key] === undefined) continue
    if (input[key] !== null && typeof input[key] !== 'string') fail(400, `El campo ${key} no es válido`)
    const value = input[key]?.trim() || null
    if (value && value.length > max) fail(400, `El campo ${key} admite hasta ${max} caracteres`)
    result[key] = value
  }
  return result
}
async function validateSupervisor(db, scope, raw, employeeId) {
  if (raw === undefined) return undefined
  if (raw === null || raw === '') return null
  const id = toUuid(raw, 'El supervisor no es válido')
  if (id === employeeId) fail(400, 'El empleado no puede supervisarse a sí mismo')
  const supervisor = await db.employee.findFirst({ where: { ...scope, id, status: 'ACTIVO' }, select: { id: true } })
  if (!supervisor) fail(404, 'El supervisor no existe o no está disponible en este ámbito')
  return id
}
module.exports = { employeeExtras, validateSupervisor }
