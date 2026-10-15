require('./setup-env')
const test = require('node:test'), assert = require('node:assert/strict')
const { createBooking, withAgendaTransaction, commercialSnapshot } = require('../src/modules/appointments/application')
test('política operativa del detalle no revela instrucciones privadas',()=>{
  const {presentSession}=require('../src/modules/appointments/presentation')
  const row={id:'s',mode:'INDIVIDUAL',status:'SCHEDULED',version:1,policy_snapshot:{durationMinutes:45,instructions:'Privado'},providers:[],resources:[],bookings:[]}
  const out=presentSession(row,{permissions:['appointments.view'],isAdmin:false})
  assert.equal(out.schedulingPolicy.durationMinutes,45)
  assert.equal('instructions' in out.schedulingPolicy,false)
})
test('reserva rechaza precio, estado o tenant arbitrarios antes de abrir transacción', async () => {
  let writes = 0
  const db = { $transaction: async () => { writes++ } }
  const scope = { branchId: 'branch', isAdmin: true, permissions: [] }
  for (const extra of [{ price: '1' }, { paid: true }, { companyId: 'foreign' }, { status: 'COMPLETED' }]) {
    await assert.rejects(() => createBooking(db, scope, extra), { status: 400 })
  }
  assert.equal(writes, 0)
})
test('snapshot toma precio y unidad del catálogo sin convertir minutos a horas', () => {
  const value = commercialSnapshot({ name: 'Consulta', kind: 'SERVICE', service_unit_label: 'Sesión', quantity_decimals: 0, price: '150.00' }, '1', 'GTQ')
  assert.deepEqual(value, { name: 'Consulta', unit: 'Sesión', quantityDecimals: 0, quantity: '1', unitPrice: '150.00', total: '150.00', currencyCode: 'GTQ' })
  assert.throws(() => commercialSnapshot({ kind: 'SERVICE', service_unit_label: 'Sesión', quantity_decimals: 0, price: '150' }, '1.5', 'GTQ'), /decimales/)
})
test('bloqueo parametrizado pertenece a la misma transacción que el trabajo', async () => {
  const calls = [], tx = { $executeRaw: async (strings, value) => calls.push(value) }
  const db = { $transaction: async (run, options) => { assert.equal(options.timeout, 30000); return run(tx) } }
  assert.equal(await withAgendaTransaction(db, 'company', async client => { assert.equal(client, tx); calls.push('write'); return 4 }), 4)
  assert.deepEqual(calls, ['appointments:company', 'write'])
})
test('puente de Asistencia bloquea Agenda efectiva incluso sin prestador para participantes usuarios', async () => {
  const { withEmployeeAgendaLock } = require('../src/modules/appointments/application')
  let locked = 0, modules = [], linked = null
  const tx = { $executeRaw: async () => { locked++ } }
  const db = { companyModule: { findMany: async () => modules }, serviceProvider: { findFirst: async () => linked } }
  const transaction = { $transaction: async run => run(tx) }
  await withEmployeeAgendaLock(db, transaction, 'c', ['e'], async client => assert.equal(client, db))
  modules = [{ module_code: 'appointments', status: 'ACTIVE' }]
  await withEmployeeAgendaLock(db, transaction, 'c', ['e'], async client => assert.equal(client, tx))
  linked = { id: 'p' }
  await withEmployeeAgendaLock(db, transaction, 'c', ['e'], async client => assert.equal(client, tx))
  assert.equal(locked, 2)
})
