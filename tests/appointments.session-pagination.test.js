const test = require('node:test'), assert = require('node:assert/strict')
const { withMocks } = require('./helpers/reportHarness.cjs')
const target = require.resolve('../src/modules/appointments/queries')
const access = require.resolve('../src/modules/appointments/access')
const id = '00000000-0000-4000-8000-000000000001'
test('session participants and waitlist use the requested bounded size without changing scope or FIFO order', async () => {
  const calls = {}, empty = { findMany: async () => [] }
  const row = { id, branch_id: 'B', providers: [], resources: [], occupied_from: new Date('2030-01-01T10:00Z'), occupied_until: new Date('2030-01-01T11:00Z'), bookings: [] }
  const db = { appointmentSession: { findFirst: async () => row }, scheduleCalendar: empty, serviceProvider: empty, scheduleResource: empty, companyModule: empty, appointmentHistory: empty,
    appointmentBooking: { count: async () => 250, findMany: async args => { calls.bookings = args; return [] } },
    appointmentWaitlist: { count: async () => 200, findMany: async args => { calls.waitlist = args; return [] } } }
  await withMocks({ [access]: { assertAppointmentsEnabled: async () => {}, agendaCapabilities: async () => ({}), hasAgendaPermission: () => false, appointmentWhere: () => ({ company_id: 'A', branch_id: 'B' }) } }, target, async queries => {
    for (const size of [10, 25, 50, 100]) {
      const result = await queries.getSession(db, { companyId: 'A' }, id, { page: '2', waitPage: '3', pageSize: String(size) })
      assert.equal(calls.bookings.take, size); assert.equal(calls.bookings.skip, size)
      assert.equal(calls.waitlist.take, size); assert.equal(calls.waitlist.skip, size * 2)
      assert.deepEqual(calls.waitlist.orderBy, [{ created_at: 'asc' }, { id: 'asc' }])
      assert.equal(calls.bookings.where.company_id, 'A'); assert.equal(calls.waitlist.where.session_id, id)
      assert.equal(result.bookings.pageSize, size); assert.equal(result.waitlist.pageSize, size)
    }
    for (const pageSize of ['101', '-1', '2.5', 'bad']) await assert.rejects(queries.getSession(db, { companyId: 'A' }, id, { pageSize }))
  })
})
