const test = require('node:test')
const assert = require('node:assert/strict')
const { withMocks, jsonResponse } = require('./helpers/reportHarness.cjs')

const cash = { id: 1, name: 'Efectivo', settlement_kind: 'CASH', is_credit: false }
const bank = { id: 2, name: 'Tarjeta', settlement_kind: 'BANK', is_credit: false }
function fixture({ sessionBranch = 'B', closureStatus = 'Pendiente' } = {}) {
  const writes = [], payments = []
  const session = { id: 'SESSION', opened_by_id: 'U', status: 'CLOSED', opening_float: 200, opened_at: new Date('2026-10-28T14:00:00Z'), closed_at: new Date('2026-10-28T18:00:00Z'), cash_closure_id: null }
  const closure = { id: 'C', branch_id: 'B', cashier_id: 'OTHER', status: closureStatus, updated_at: new Date('2026-10-28T18:01:00Z') }
  const db = {
    $queryRaw: async () => [],
    cashRegisterSession: {
      findFirst: async ({ where }) => where.cashRegister?.branch_id && where.cashRegister.branch_id !== sessionBranch ? null : session,
      updateMany: async () => ({ count: 1 }),
    },
    saleStatus: { findFirst: async () => ({ id: 1 }) },
    sale: { findMany: async () => [
      { id: 'S1', total: 100, payment_method_id: 1, payment_method: cash },
      { id: 'S2', total: 80, payment_method_id: 2, payment_method: bank },
    ] },
    customerPayment: { findMany: async () => [{ id: 'P1', amount: 50, payment_method_id: 1, payment_method: cash }] },
    returnSettlement: { findMany: async () => [{ id: 'R1', kind: 'REFUND', amount: 20, payment_method_id: 1, payment_method: cash }] },
    customerPaymentRefund: { findMany: async () => [] },
    cashClosure: {
      findFirst: async () => closure,
      create: async ({ data }) => { writes.push(data); return { id: 'C' } },
      findUnique: async () => ({ ...closure, ...writes.at(-1) }),
      update: async ({ data }) => { writes.push(data); Object.assign(closure, data); return closure },
      updateMany: async ({ where, data }) => {
        if (where.status && closure.status !== where.status || where.updated_at && +new Date(where.updated_at) !== +closure.updated_at) return { count: 0 }
        writes.push(data); Object.assign(closure, data); return { count: 1 }
      },
    },
    cashClosurePayment: { create: async ({ data }) => { payments.push(data); return data } },
    cashClosureDenomination: { create: async ({ data }) => data },
  }
  db.$transaction = async work => work(db)
  const user = { sub: 'U', name: 'Operador', role: { name: 'Cajero', company_id: 'A' }, permissions: ['cashclosure.create_own'] }
  const req = { companyId: 'A', branchId: 'B', user, query: { cashier_id: 'U', cash_register_session_id: 'SESSION' }, params: { id: 'C' } }
  const body = { startDate: '2026-10-28T08:00:00', endDate: '2026-10-28T12:00:00', cashierId: 'U', cashierName: 'Operador', cash_register_session_id: 'SESSION', theoreticalTotal: 1, theoreticalSales: 1, theoreticalReturns: 0, actualTotal: 410, totalTransactions: 999, totalCustomers: 999, averageTicket: 999, notes: 'Conteo revisado', paymentBreakdowns: [{ payment_method_id: 1, actual_amount: 330, theoretical_amount: 1, theoretical_count: 999 }, { payment_method_id: 2, actual_amount: 80, theoretical_amount: 0, theoretical_count: 0 }], denominations: [] }
  return { db, writes, payments, req, body, closure }
}
async function run(f, action) {
  return withMocks({ [require.resolve('../src/models/prisma')]: { prisma: f.db }, [require.resolve('../src/utils/getTimezone')]: { getTimezone: async () => 'America/Guatemala' } }, require.resolve('../src/modules/cash-closure/controller'), action)
}
async function preview(controller, req) {
  const res = jsonResponse(); await controller.calculateTheoretical(req, res, e => { throw e }); return res
}

test('saving a closure recomputes expected money, sources and dates instead of trusting browser totals', async () => {
  const f = fixture()
  await run(f, async controller => {
    const data = (await preview(controller, f.req)).body
    assert.equal(data.theoretical.net_total, 410)
    assert.equal(data.metrics.average_ticket, 90, 'the ticket average excludes opening float and collections of older debts')
    const res = jsonResponse()
    await controller.create({ ...f.req, body: { ...f.body, calculationKey: data.calculation_key, supervisorId: 'FORGED', supervisorName: 'Falso' } }, res, e => { throw e })
    assert.equal(res.statusCode, 201)
    assert.equal(Number(f.writes[0].theoretical_total), 410)
    assert.equal(Number(f.writes[0].difference), 0)
    assert.equal(f.writes[0].total_transactions, 2)
    assert.equal(+f.writes[0].start_date, +new Date('2026-10-28T14:00:00Z'))
    assert.equal(f.writes[0].supervisor_id, undefined)
    assert.equal(Number(f.payments[0].theoretical_amount), 330)
  })
})

test('a stale calculation cannot be saved after receipts change', async () => {
  const f = fixture()
  await run(f, async controller => {
    const data = (await preview(controller, f.req)).body
    f.db.customerPayment.findMany = async () => [{ id: 'P2', amount: 60, payment_method_id: 1, payment_method: cash }]
    const res = jsonResponse()
    await controller.create({ ...f.req, body: { ...f.body, calculationKey: data.calculation_key } }, res, e => { throw e })
    assert.equal(res.statusCode, 409)
    assert.deepEqual(f.writes, [])
  })
})

test('malformed period values produce a validation error rather than a server exception', async () => {
  const f = fixture(); f.req.user.permissions = ['cashclosure.create_day']; f.req.query = { startDate: 123, endDate: '2026-10-28T18:00:00Z' }
  await run(f, async controller => { assert.equal((await preview(controller, f.req)).statusCode, 400) })
})

test('an unusually large declared difference does not overflow the optional percentage column', async () => {
  const f = fixture()
  await run(f, async controller => {
    const data = (await preview(controller, f.req)).body, res = jsonResponse()
    await controller.create({ ...f.req, body: { ...f.body, calculationKey: data.calculation_key, actualTotal: 1000000080, paymentBreakdowns: [{ payment_method_id: 1, actual_amount: 1000000000, notes: 'Conteo extraordinario; requiere revisión' }, { payment_method_id: 2, actual_amount: 80 }] } }, res, e => { throw e })
    assert.equal(res.statusCode, 201); assert.equal(f.writes[0].difference_percentage, null)
  })
})

test('session lookup is scoped to the active branch and cannot disclose another branch shift', async () => {
  const f = fixture({ sessionBranch: 'OTHER' })
  await run(f, async controller => { const res = await preview(controller, f.req); assert.equal(res.statusCode, 404) })
})

test('a legacy Admin name cannot obtain general closure authority from an own-only permission', async () => {
  const f = fixture(); f.req.user.role.name = 'Admin'; f.req.query = { startDate: '2026-10-28T08:00:00', endDate: '2026-10-28T12:00:00' }
  await run(f, async controller => { const res = await preview(controller, f.req); assert.equal(res.statusCode, 403) })
})

for (const invalid of [NaN, -1, '1e2', '12.345', true]) test(`invalid declared amount ${String(invalid)} cannot persist a closure`, async () => {
  const f = fixture()
  await run(f, async controller => {
    const data = (await preview(controller, f.req)).body, res = jsonResponse()
    await controller.create({ ...f.req, body: { ...f.body, calculationKey: data.calculation_key, actualTotal: invalid } }, res, e => { throw e })
    assert.equal(res.statusCode, 400); assert.deepEqual(f.writes, [])
  })
})

for (const patch of [
  { paymentBreakdowns: [{ payment_method_id: 99, actual_amount: 410 }] },
  { paymentBreakdowns: [{ payment_method_id: 1, actual_amount: 330 }, { payment_method_id: 1, actual_amount: 80 }] },
  { actualTotal: 409 },
  { denominations: [{ denomination: 100, quantity: 2, type: 'Billete' }] },
  { denominations: [{ denomination: 100, quantity: 3.3, type: 'Billete' }] },
]) test('declared methods, denominations and aggregate must agree with the authorized calculation ' + JSON.stringify(patch), async () => {
  const f = fixture()
  await run(f, async controller => {
    const data = (await preview(controller, f.req)).body, res = jsonResponse()
    await controller.create({ ...f.req, body: { ...f.body, calculationKey: data.calculation_key, ...patch } }, res, e => { throw e })
    assert.equal(res.statusCode, 400); assert.deepEqual(f.writes, [])
  })
})

test('approved closures are terminal even through the legacy status endpoint', async () => {
  const f = fixture({ closureStatus: 'Aprobado' })
  f.req.user.permissions = ['cashclosure.approve']
  await run(f, async controller => {
    const res = jsonResponse()
    await controller.updateStatus({ ...f.req, body: { status: 'Pendiente', expectedUpdatedAt: f.closure.updated_at.toISOString() } }, res, e => { throw e })
    assert.equal(res.statusCode, 409); assert.deepEqual(f.writes, [])
  })
})

test('a signature cannot modify an approved closure', async () => {
  const f = fixture({ closureStatus: 'Aprobado' })
  await run(f, async controller => {
    const res = jsonResponse()
    await controller.validate({ ...f.req, user: { sub: 'MANAGER', name: 'Encargado', permissions: ['cashclosure.validate'] }, body: { expectedUpdatedAt: f.closure.updated_at.toISOString(), supervisorName: 'Falso', supervisorSignature: 'data:image/png;base64,AAAA' } }, res, e => { throw e })
    assert.equal(res.statusCode, 409); assert.deepEqual(f.writes, [])
  })
})

test('a rejected closure requires a meaningful reason', async () => {
  const f = fixture()
  await run(f, async controller => {
    const res = jsonResponse()
    await controller.updateStatus({ ...f.req, user: { sub: 'MANAGER', permissions: ['cashclosure.approve'] }, body: { status: 'Rechazado', expectedUpdatedAt: f.closure.updated_at.toISOString(), rejection_reason: ' ' } }, res, e => { throw e })
    assert.equal(res.statusCode, 400); assert.deepEqual(f.writes, [])
  })
})

test('a concurrent review cannot overwrite the first reviewer', async () => {
  const f = fixture(); f.db.cashClosure.updateMany = async () => ({ count: 0 })
  await run(f, async controller => {
    const res = jsonResponse()
    await controller.updateStatus({ ...f.req, user: { sub: 'MANAGER', permissions: ['cashclosure.approve'] }, body: { status: 'Aprobado', expectedUpdatedAt: f.closure.updated_at.toISOString() } }, res, e => { throw e })
    assert.equal(res.statusCode, 409); assert.deepEqual(f.writes, [])
  })
})

for (const version of [undefined, '2026-10-28T17:00:00Z']) test('review requires the current record version ' + version, async () => {
  const f = fixture()
  await run(f, async controller => {
    const res = jsonResponse()
    await controller.updateStatus({ ...f.req, user: { sub: 'MANAGER', name: 'Encargado', permissions: ['cashclosure.approve'] }, body: { status: 'Aprobado', expectedUpdatedAt: version, supervisor_id: 'FORGED' } }, res, e => { throw e })
    assert.equal(res.statusCode, version ? 409 : 428); assert.deepEqual(f.writes, [])
  })
})

test('review records the authenticated manager and uses a conditional state change', async () => {
  const f = fixture()
  await run(f, async controller => {
    const res = jsonResponse()
    await controller.updateStatus({ ...f.req, user: { sub: 'MANAGER', name: 'Encargado', permissions: ['cashclosure.approve'] }, body: { status: 'Aprobado', expectedUpdatedAt: f.closure.updated_at.toISOString(), supervisor_id: 'FORGED', supervisor_name: 'Falso' } }, res, e => { throw e })
    assert.equal(res.statusCode, 200); assert.equal(f.writes[0].supervisor_id, 'MANAGER'); assert.equal(f.writes[0].supervisor_name, 'Encargado')
  })
})

for (const explained of ['none', 'cash', 'both']) test(`each discrepant medium needs its own reason: ${explained}`, async () => {
  const f = fixture()
  await run(f, async controller => {
    const data = (await preview(controller, f.req)).body, res = jsonResponse()
    const payments = [{ payment_method_id: 1, actual_amount: 320, notes: explained !== 'none' ? 'Error al dar cambio' : '' }, { payment_method_id: 2, actual_amount: 90, notes: explained === 'both' ? 'Comprobante adicional revisado' : '' }]
    await controller.create({ ...f.req, body: { ...f.body, calculationKey: data.calculation_key, notes: explained === 'both' ? '' : 'Comentario global', paymentBreakdowns: payments } }, res, e => { throw e })
    assert.equal(res.statusCode, explained === 'both' ? 201 : 400)
    assert.equal(f.writes.length, explained === 'both' ? 1 : 0)
  })
})

test('a second reviewer never inherits a different person signature', async () => {
  const f = fixture(); Object.assign(f.closure, { supervisor_id: 'SIGNER', supervisor_name: 'Firmante', supervisor_signature: 'data:image/png;base64,AAAA' })
  await run(f, async controller => {
    const res = jsonResponse()
    await controller.updateStatus({ ...f.req, user: { sub: 'MANAGER', name: 'Encargado', permissions: ['cashclosure.approve'] }, body: { status: 'Aprobado', expectedUpdatedAt: f.closure.updated_at.toISOString() } }, res, e => { throw e })
    assert.equal(res.statusCode, 200); assert.equal(res.body.supervisor_id, 'MANAGER'); assert.equal(res.body.supervisor_signature, null)
  })
})
