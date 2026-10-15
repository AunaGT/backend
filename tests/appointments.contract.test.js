const test = require('node:test')
const assert = require('node:assert/strict')
const { nextBookingState, nextSessionState, occupiesSeat } = require('../src/modules/appointments/domain/states')
const { parseProfile, parseBooking, parseCalendar, parseFilter, parseTransition } = require('../src/modules/appointments/domain/validation')
const id = '00000000-0000-4000-8000-000000000001'
const profile = { enabled: false, mode: 'INDIVIDUAL', durationMinutes: 45, beforeMinutes: 0,
  afterMinutes: 0, intervalMinutes: 15, leadMinutes: 0, horizonDays: 60, cancellationHours: 24,
  confirmation: 'AUTOMATIC', capacity: 1, requiresProvider: true, requiresResource: false,
  branchIds: [id], providerIds: [], resourceIds: [], instructions: '' }

test('atender y finalizar nunca implica cobrar ni permite revivir un estado terminal', () => {
  assert.equal(nextBookingState('CONFIRMED', 'ARRIVE'), 'ARRIVED')
  assert.equal(nextBookingState('ARRIVED', 'START'), 'IN_SERVICE')
  assert.equal(nextBookingState('IN_SERVICE', 'COMPLETE'), 'COMPLETED')
  assert.equal(nextSessionState('IN_PROGRESS', 'COMPLETE'), 'COMPLETED')
  for (const state of ['COMPLETED', 'CANCELLED', 'EXPIRED', 'NO_SHOW']) {
    assert.throws(() => nextBookingState(state, 'CONFIRM'), { code: 'INVALID_TRANSITION', status: 409 })
  }
  assert.throws(() => nextSessionState('SCHEDULED', 'COMPLETE'), { status: 409 })
  assert.throws(() => nextBookingState('CONFIRMED', 'PAID'), { status: 409 })
})
test('a igualdad de vencimiento se libera cupo sin depender de un job', () => {
  const now = new Date('2026-10-12T15:00:00Z')
  for (const status of ['HELD', 'PENDING']) {
    assert.equal(occupiesSeat({ status, expires_at: now }, now), false)
    assert.equal(occupiesSeat({ status, expires_at: new Date('2026-10-12T15:00:01Z') }, now), true)
    assert.equal(occupiesSeat({ status, expires_at: null }, now), false)
  }
  assert.equal(occupiesSeat({ status: 'CONFIRMED' }, now), true)
  assert.equal(occupiesSeat({ status: 'CANCELLED' }, now), false)
})
test('perfil conserva duración independiente y rechaza campos comerciales o públicos', () => {
  assert.equal(parseProfile(profile).durationMinutes, 45)
  for (const patch of [{ durationMinutes: 0 }, { capacity: 2 }, { beforeMinutes: -1 },
    { enabled: 'true' }, { paid: true }, { price: '1' }, { public: true }, { branchIds: ['foreign'] }]) {
    assert.throws(() => parseProfile({ ...profile, ...patch }), { status: 400 })
  }
  assert.equal(parseProfile({ ...profile, enabled: true, requiresProvider: false }).requiresResource,false)
})
test('reserva exige instante con zona, cantidad decimal string y no admite tenant enviado', () => {
  const input = { productId: id, contactId: id, startsAt: '2026-10-12T09:00:00-06:00',
    timezone: 'America/Guatemala', providerIds: [id], resourceIds: [], quantity: '1', notes: '', idempotencyKey: 'qa-request-1' }
  assert.equal(parseBooking(input).startsAt, '2026-10-12T15:00:00.000Z')
  for (const patch of [{ startsAt: '2026-10-12T09:00' }, { quantity: 1.5 }, { quantity: '0' },
    { companyId: id }, { price: '1' }, { timezone: 'Not/AZone' }, { status: 'CONFIRMED' }]) {
    assert.throws(() => parseBooking({ ...input, ...patch }), { status: 400 })
  }
})
test('calendario no convierte turno invertido ni acepta excepción parcial inconsistente', () => {
  const input = { timezone: 'America/Guatemala', expectedVersion: 0,
    weekly: [{ weekday: 1, from: '09:00', to: '12:00' }], exceptions: [] }
  assert.equal(parseCalendar(input).weekly.length, 1)
  assert.equal(parseCalendar({ ...input, weekly: [{ weekday: 1, from: '22:00', to: '24:00' }] }).weekly[0].to, '24:00')
  for (const weekly of [[{ weekday: 1, from: '22:00', to: '02:00' }],
    [{ weekday: 1, from: '24:00', to: '24:00' }], [{ weekday: 1, from: '09:00', to: '12:00' }, { weekday: 1, from: '11:00', to: '13:00' }]]) {
    assert.throws(() => parseCalendar({ ...input, weekly }), { status: 400 })
  }
  assert.throws(() => parseCalendar({ ...input, exceptions: [{ date: '2026-02-30', from: null, to: null, reason: '' }] }), { status: 400 })
  assert.throws(() => parseCalendar({ ...input, validFrom: '2026-10-20', validUntil: '2026-10-12' }), { status: 400 })
})
test('filtros limitan datos y transiciones exigen versión, motivo de cancelación e idempotencia', () => {
  const filter = { from: '2026-10-12T00:00:00Z', to: '2026-10-13T00:00:00Z' }
  assert.equal(parseFilter(filter).pageSize, 10)
  assert.throws(() => parseFilter({ ...filter, pageSize: '101' }), { status: 400 })
  assert.throws(() => parseFilter({ ...filter, to: '2027-10-12T00:00:00Z' }), { status: 400 })
  assert.throws(() => parseTransition({ action: 'CANCEL', expectedVersion: 1, idempotencyKey: 'qa-request-1', reason: '' }), { status: 400 })
})
