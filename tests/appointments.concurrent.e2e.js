const test = require('node:test'), assert = require('node:assert/strict'), crypto = require('node:crypto')
const { withAppointmentsTestDb, seedAgenda } = require('./helpers/appointmentsTestDb.cjs')
const { createBooking, enrollBooking, rescheduleBooking, withAgendaTransaction } = require('../src/modules/appointments/application')
async function raceBehindLock(db, scope, run) {
  let release, ready
  const gate = new Promise(resolve => { release = resolve }), entered = new Promise(resolve => { ready = resolve })
  const holder = withAgendaTransaction(db, scope.companyId, async () => { ready(); await gate })
  await entered
  const results = Promise.allSettled(run())
  try {
    const until = Date.now() + 5000
    let waiting = 0
    while (waiting < 2 && Date.now() < until) {
      const [row] = await db.$queryRaw`SELECT count(*)::int AS count FROM pg_locks WHERE locktype='advisory' AND NOT granted`
      waiting = row.count
    }
    assert.ok(waiting >= 2, 'dos transacciones realmente esperan el bloqueo, no solo mocks en paralelo')
  } finally { release(); await holder }
  return results
}
test('reservas, último cupo y moves compiten bajo bloqueo real; rollback conserva originales', async () => withAppointmentsTestDb(async context => {
  await seedAgenda(context)
  const { db, scope, fixtures: f } = context
  const attempts = [0, 1].map(() => ({ ...f.individualInput, idempotencyKey: crypto.randomUUID() }))
  const result = await raceBehindLock(db, scope, () => attempts.map(input => createBooking(db, scope, input)))
  assert.equal(result.filter(r => r.status === 'fulfilled').length, 1)
  assert.equal(result.find(r => r.status === 'rejected').reason.status, 409)
  const winner = result.findIndex(r => r.status === 'fulfilled'), first = result[winner].value
  assert.equal((await createBooking(db, scope, attempts[winner])).id, first.id)
  await assert.rejects(() => createBooking(db, scope, { ...attempts[winner], notes: 'distinto' }), { status: 409, code: 'IDEMPOTENCY_CONFLICT' })
  await assert.rejects(() => createBooking(db, { ...scope, branchId: f.secondBranchId }, { ...attempts[0], idempotencyKey: crypto.randomUUID() }), { status: 409 })
  const contacts = await Promise.all([0, 1].map(i => db.supplier.create({ data: { company_id: scope.companyId, name: `Cliente ${i}`, contact: `Cliente ${i}`, party_type: 'CUSTOMER' } })))
  const enrolls = await raceBehindLock(db, scope, () => contacts.map(c => enrollBooking(db, scope, f.groupSessionId, { contactId: c.id, quantity: '1', notes: '', idempotencyKey: crypto.randomUUID() })))
  assert.equal(enrolls.filter(r => r.status === 'fulfilled').length, 1)
  assert.equal(enrolls.find(r => r.status === 'rejected').reason.status, 409)
  const second = await createBooking(db, scope, { ...attempts[0], startsAt: new Date(new Date(first.startsAt).getTime() + 7200000).toISOString(), idempotencyKey: crypto.randomUUID() })
  const target = new Date(new Date(first.startsAt).getTime() + 14400000).toISOString()
  const moved = await raceBehindLock(db, scope, () => [first, second].map(b => rescheduleBooking(db, scope, b.id, { startsAt: target, timezone: b.timezone, providerIds: b.providerIds, resourceIds: b.resourceIds, expectedVersion: b.version, reason: 'Reorganización QA', idempotencyKey: crypto.randomUUID() })))
  assert.equal(moved.filter(r => r.status === 'fulfilled').length, 1)
  const loser = moved.findIndex(r => r.status === 'rejected'), original = [first, second][loser]
  const unchanged = await db.appointmentBooking.findUnique({ where: { id: original.id }, include: { session: true } })
  assert.equal(unchanged.session.starts_at.toISOString(), original.startsAt)
  assert.equal(unchanged.version, original.version)
  assert.equal(unchanged.commercial_snapshot.total, '150.00')
  assert.equal(await db.sale.count(), 0)
  assert.equal(await db.customerPayment.count(), 0)
  assert.equal(await db.productStock.count(), 0)
}))
