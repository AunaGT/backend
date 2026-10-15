require('./setup-env')
const test = require('node:test'), assert = require('node:assert/strict')
const { saveCalendar, getCalendar } = require('../src/modules/appointments/calendars')
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const scope = { companyId: id(1), branchId: id(2), branchIds: [id(2)], userId: id(3), permissions: ['appointments.configure'], isAdmin: false }
const input = { timezone: 'America/Guatemala', expectedVersion: 0, weekly: [{ weekday: 1, from: '09:00', to: '12:00' }], exceptions: [{ date: '2026-10-12', from: null, to: null, reason: 'Feriado' }] }
function fixture() {
  const writes = []
  const db = { branch: { findFirst: async () => ({ id: id(2) }) },
    companyModule: { findMany: async () => [{ module_code: 'appointments', status: 'ACTIVE' }] },
    systemSetting: { findUnique: async () => ({ value: 'true' }) },
    scheduleCalendar: { findFirst: async () => null, create: async ({ data }) => ({ id: id(4), version: 1, ...data }), updateMany: async () => ({ count: 0 }) } }
  for (const model of ['availabilityRule', 'availabilityException']) db[model] = { deleteMany: async () => ({}), createMany: async ({ data }) => { writes.push({ model, data }); return { count: data.length } } }
  return { db, writes }
}
test('guardar horario convierte minutos y reemplaza reglas solo después de validar dueño/versión', async () => {
  const { db, writes } = fixture()
  const result = await saveCalendar(db, scope, 'branch', id(2), input)
  assert.equal(result.version, 1)
  assert.equal(writes[0].data[0].from_minute, 540)
  assert.equal(writes[0].data[0].to_minute, 720)
  assert.equal(writes[1].data[0].from_minute, null)
  writes.length = 0
  db.scheduleCalendar.findFirst = async () => ({ id: id(4), version: 2 })
  await assert.rejects(() => saveCalendar(db, scope, 'branch', id(2), { ...input, expectedVersion: 1 }), { status: 409 })
  assert.equal(writes.length, 0)
})
test('dueño ajeno y heredar horario de la propia sucursal no crean disponibilidad', async () => {
  const { db, writes } = fixture()
  await assert.rejects(() => saveCalendar(db, scope, 'branch', id(9), input), { status: 404 })
  await assert.rejects(() => saveCalendar(db, scope, 'branch', id(2), { ...input, inheritBranch: true }), { status: 400 })
  assert.equal(writes.length, 0)
  assert.equal(await getCalendar(db, scope, 'branch', id(2)), null)
})
