const test = require('node:test'), assert = require('node:assert/strict'), { randomUUID } = require('node:crypto')
test('ordinary payment hash is stable for numeric spelling, sorted applications and omitted server time', () => {
  const { paymentHash } = require('../src/modules/receivables/paymentAttempts')
  const a = { customer_id: randomUUID(), amount: '50.00', payment_method_id: 1, applications: [{ sale_id: 'b', amount: 20 }, { sale_id: 'a', amount: 30 }] }
  assert.equal(paymentHash(a), paymentHash({ ...a, amount: 50, applications: a.applications.toReversed() }))
  for (const change of [{ amount: 51 }, { customer_id: randomUUID() }, { cash_register_session_id: randomUUID() }, { paid_at: '2026-10-28T12:00:00Z' }]) assert.notEqual(paymentHash(a), paymentHash({ ...a, ...change }))
  for (const amount of ['1e2', '1.001', -1, 'NaN']) assert.throws(() => paymentHash({ ...a, amount }), e => e.status === 400)
})
test('opening float accepts exact zero spellings but rejects malformed, negative and imprecise money before database work', async () => {
  const { withMocks, jsonResponse } = require('./helpers/reportHarness.cjs')
  await withMocks({ [require.resolve('../src/models/prisma')]: { prisma: {} } }, require.resolve('../src/modules/sales/cashSessions.controller'), async api => {
    for (const opening_float of ['1abc', '0.001', 'NaN', true, -1, '1e2']) {
      const res = jsonResponse(); let error
      await api.openSession({ user: { sub: 'u', permissions: ['sales.create'] }, body: { opening_float } }, res, e => { error = e })
      assert.equal(error?.status || res.statusCode, 400)
    }
  })
  const { exactMoney } = require('../src/modules/receivables/paymentAttempts')
  assert.equal(exactMoney('0.0', { allowZero: true }), '0.00')
  assert.throws(() => exactMoney('0.0'))
})
