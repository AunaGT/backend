const test = require('node:test')
const assert = require('node:assert/strict')
const domain = require('../src/modules/receivables/domain/receivables')

function controller(t, prisma) {
  const paths = ['../src/models/prisma', '../src/middlewares/tenant', '../src/utils/getTimezone', '../src/modules/receivables/controller'].map(require.resolve)
  const cached = paths.map(path => require.cache[path])
  require.cache[paths[0]] = { exports: { prisma } }
  require.cache[paths[1]] = { exports: { requireCompany: req => req.companyId, requireBranch: req => req.branchId } }
  require.cache[paths[2]] = { exports: { getTimezone: async () => 'America/Guatemala' } }
  delete require.cache[paths[3]]
  t.after(() => paths.forEach((path, index) => { if (cached[index]) require.cache[path] = cached[index]; else delete require.cache[path] }))
  return require(paths[3])
}

test('facturas: paginación, fechas locales y aislamiento de empresa/sucursales', async t => {
  let where
  const c = controller(t, { sale: {
    count: async args => { where = args.where; return 26 },
    findMany: async args => {
      assert.equal(args.skip, 20)
      assert.equal(args.take, 10)
      assert.deepEqual(args.where, where)
      return [{ id: 'sale', reference: 'FV-1', date: new Date(), due_date: new Date('2025-01-01'), adjusted_total: 100, payment_status: 'PARTIAL', paymentEntries: [{ amount: 30 }], customerContact: { id: 'client', name: 'Cliente' } }]
    },
  } })
  let result
  await c.invoices({ companyId: 'company-a', branchIds: ['branch-a', 'branch-b'], query: { search: 'Cliente', state: 'OVERDUE', page: 9, pageSize: 10, date_from: '2026-09-01', date_to: '2026-09-30' } }, { json: value => { result = value } }, error => { throw error })
  assert.deepEqual(where.branch_id, { in: ['branch-a', 'branch-b'] })
  assert.equal(where.customerContact.company_id, 'company-a')
  assert.equal(where.date.gte.toISOString(), '2026-09-01T06:00:00.000Z')
  assert.equal(where.date.lt.toISOString(), '2026-10-01T06:00:00.000Z')
  assert.equal(where.OR[1].customerContact.name.contains, 'Cliente')
  assert.equal(result.page, 3)
  assert.equal(result.items[0].saldo, 70)
  assert.equal(result.items[0].vencida, true)
})

test('facturas rechaza filtros inválidos antes de consultar', async t => {
  const c = controller(t, {})
  for (const query of [{ state: 'INVALID' }, { date_from: '2026-02-30' }, { date_from: '2026-10-01', date_to: '2026-09-01' }, { customer_id: 'wrong' }]) {
    let error
    await c.invoices({ companyId: 'company', branchId: 'branch', query }, { json: () => assert.fail('No debe consultar') }, e => { error = e })
    assert.equal(error?.status, 400)
  }
})

test('estado de cuenta: historial por páginas sin truncar el resumen ni las condiciones de crédito', async t => {
  const c = controller(t, {
    supplier: { findFirst: async args => {
      assert.deepEqual(args.where, { id: 'client', company_id: 'company' })
      return { id: 'client', name: 'Cliente', credit_limit: 1000, supplier_payment_terms: [{ payment_term: { name: '30 días', net_days: 30 } }] }
    } },
    sale: {
      count: async args => { assert.equal(args.where.branch_id, 'branch'); return 300 },
      findMany: async args => {
        assert.equal(args.where.branch_id, 'branch')
        if (args.skip !== undefined) { assert.equal(args.skip, 100); assert.equal(args.take, 100); return [] }
        return [{ id: 'old', adjusted_total: 80, due_date: new Date('2025-01-01'), paymentEntries: [] }]
      },
    },
    customerPayment: {
      count: async () => 0,
      findMany: async args => { assert.equal(args.where.branch_id, 'branch'); return [] },
    },
  })
  let result
  await c.statement({ companyId: 'company', branchId: 'branch', params: { id: 'client' }, query: { page: 2, pageSize: 100 } }, { json: value => { result = value } }, error => { throw error })
  assert.equal(result.history.hasNextPage, true)
  assert.equal(result.history.total_sales, 300)
  assert.equal(result.resumen.saldo, 80)
  assert.equal(result.resumen.vencido_30_mas, 80)
  assert.equal(result.customer.payment_term.net_days, 30)
})

test('saldos y cobros: antigüedad completa, anticipos y rechazo de sobreaplicaciones', async () => {
  const summary = await domain.customerBalance({
    sale: { findMany: async () => [
      { id: 'old', adjusted_total: 100, due_date: new Date('2026-07-01'), paymentEntries: [{ amount: 20 }] },
      { id: 'recent', adjusted_total: 50, due_date: new Date('2026-09-20'), paymentEntries: [] },
    ] },
    customerPayment: { findMany: async () => [{ amount: 30, applications: [{ amount: 20 }] }] },
  }, 'client', {}, new Date('2026-10-01'))
  assert.equal(summary.saldo, 130)
  assert.equal(summary.vencido, 130)
  assert.equal(summary.vencido_30_mas, 80)
  assert.equal(summary.saldo_neto, 120)
  assert.deepEqual(domain.planFifo([{ id: 'one', balance: 20 }, { id: 'two', balance: 30 }], 60), { applications: [{ sale_id: 'one', amount: 20 }, { sale_id: 'two', amount: 30 }], unapplied: 10 })
  assert.throws(() => domain.planManual([{ id: 'one', balance: 20 }], [{ sale_id: 'one', amount: 25 }], 25), domain.ReceivableError)
})
