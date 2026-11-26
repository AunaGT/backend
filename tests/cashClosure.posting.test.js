const test = require('node:test'), assert = require('node:assert/strict')
const { withMocks } = require('./helpers/reportHarness.cjs')
const core = require.resolve('../src/services/accounting/core'), engine = require.resolve('../src/services/accounting/postingEngine')
const row = (kind, expected, actual) => ({ theoretical_amount: expected, actual_amount: actual, difference: actual - expected, payment_method: { settlement_kind: kind } })
async function fixture(difference, rows, run) {
  const entries = [], db = { companyModule: { findMany: async () => [] }, $executeRaw:async()=>0,
    journalEntry:{findMany:async()=>[]}, $queryRaw: async (parts, ...values) => String(parts).includes('SELECT c.* FROM cash_closures') ? [{id:'C',branch_id:'B',closure_number:1,date:new Date(),status:'Aprobado'}] : values.includes('CASH_CLOSURE') && !entries.length ? [{ id: 'C' }] : [] }
  for (const model of ['sale', 'return', 'incomingMerchandise', 'incomingMerchandisePaymentEntry', 'customerPayment']) db[model] = { findMany: async () => [] }
  db.cashClosure = { findMany: async ({ where }) => where.id.in.length ? [{ id: 'C', branch_id: 'B', closure_number: 1, date: new Date(), difference, payment_breakdowns: rows }] : [] }
  db.$transaction = async work => work(db)
  await withMocks({ [core]: { ...require(core), getDefaultAccounts: async () => ({}), getTaxConfig: async () => ({ regime: 'PEQUENO', ivaRate: 0, pequenoRate: 0 }), getCashClosureAccounts: async () => ({ cash: { id: 'CASH' }, cashOverShort: { id: 'DIFFERENCES' } }), createEntry: async (_tx, entry) => { entries.push(entry) } } }, engine, async api => run(api, db, entries))
}
test('a bank-only discrepancy never becomes physical cash', async () => {
  await fixture(-5, [row('BANK', 80, 75)], async (api, db, entries) => { await api.postPendingOperations(db, 'U', 'A'); assert.deepEqual(entries, []) })
})
test('opposite bank and cash discrepancies do not hide the cash shortage or duplicate its posting', async () => {
  await fixture(0, [row('CASH', 100, 90), row('BANK', 80, 90)], async (api, db, entries) => {
    await api.postPendingOperations(db, 'U', 'A')
    assert.equal(entries.length, 1)
    assert.deepEqual(entries[0].lines.map(l=>({...l,debit:Number(l.debit),credit:Number(l.credit)})).sort((a,b)=>a.account_id.localeCompare(b.account_id)), [{ account_id: 'CASH', debit: 0, credit: 10 }, { account_id: 'DIFFERENCES', debit: 10, credit: 0 }])
    await api.postPendingOperations(db, 'U', 'A'); assert.equal(entries.length, 1)
  })
})
for (const rows of [[], [row(null, 20, 15)]]) test('unclassified legacy discrepancies remain explicit review work ' + JSON.stringify(rows), async () => {
  await fixture(-5, rows, async (api, db, entries) => {
    const result = await api.postPendingOperations(db, 'U', 'A')
    assert.deepEqual(entries, []); assert.ok(result.skipped.some(s => /clasific|desglose|revis/i.test(s.reason)))
  })
})
test('ledger closure posting uses frozen CASH classification even if current catalog says BANK', async () => {
  await fixture(-10, [{ ...row('BANK', 100, 90), id: 1 }], async (api, db, entries) => {
    const query = db.$queryRaw
    db.$queryRaw = async (parts, ...values) => {
      if (String(parts).includes('to_regclass')) return [{ available: true }]
      if (String(parts).includes('SELECT id,calculation_snapshot')) return [{ id: 'C', calculation_snapshot: { basis: 'EVENTS_V1', payment_breakdowns: [{ id: 1, payment_method_name: 'Frozen CASH', settlement_kind: 'CASH' }] } }]
      return query(parts, ...values)
    }
    await api.postPendingOperations(db, 'U', 'A')
    assert.equal(entries.length, 1); assert.equal(Number(entries[0].lines.find(l=>l.account_id==='DIFFERENCES').debit), 10)
  })
})
