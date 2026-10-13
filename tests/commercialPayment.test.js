const test = require('node:test')
const assert = require('node:assert/strict')
const { DateTime } = require('luxon')
const { documentPaymentTerms, creditDueDate, initialPaymentAmount, recordInitialPayment } = require('../src/services/commercialPayment')

test('acuerdo de crédito requiere cliente del tenant y plazo, contado limpia el plazo', async () => {
  const tx = { supplier: { findFirst: async ({ where }) => where.company_id === 'company-a' ? { id: 'customer-a' } : null } }
  assert.deepEqual(await documentPaymentTerms(tx, {}, null, 'company-a'), { payment_condition: 'CASH', credit_days: null })
  assert.deepEqual(await documentPaymentTerms(tx, { payment_condition: 'CREDIT', credit_days: 30 }, 'customer-a', 'company-a'), { payment_condition: 'CREDIT', credit_days: 30 })
  for (const days of [null, '', -1, 0.5, 3651, 'abc', true, []]) await assert.rejects(documentPaymentTerms(tx, { payment_condition: 'CREDIT', credit_days: days }, 'customer-a', 'company-a'))
  await assert.rejects(documentPaymentTerms(tx, { payment_condition: 'CREDIT', credit_days: 30 }, null, 'company-a'))
  await assert.rejects(documentPaymentTerms(tx, { payment_condition: 'CREDIT', credit_days: 30 }, 'customer-a', 'company-b'))
  assert.deepEqual(await documentPaymentTerms(tx, { payment_condition: 'CASH' }, 'customer-a', 'company-a', { payment_condition: 'CREDIT', credit_days: 30 }), { payment_condition: 'CASH', credit_days: null })
})

test('vencimiento conserva el día local completo, admite cero días y rechaza fechas pasadas', () => {
  const issued = new Date('2026-10-02T01:00:00Z') // 1 de octubre en Guatemala
  const date = creditDueDate('2026-10-31', null, issued, 'America/Guatemala')
  assert.equal(DateTime.fromJSDate(date, { zone: 'America/Guatemala' }).toISODate(), '2026-10-31')
  assert.equal(date.toISOString(), '2026-11-01T05:59:59.999Z')
  assert.equal(creditDueDate(null, 30, issued, 'America/Guatemala').toISOString(), date.toISOString())
  assert.equal(creditDueDate(null, 0, issued, 'America/Guatemala').toISOString(), '2026-10-02T05:59:59.999Z')
  for (const raw of ['2026-09-30', '2026-02-30', '2026-10-31T00:00:00Z']) assert.throws(() => creditDueDate(raw, null, issued, 'America/Guatemala'))
})

test('abono parcial se aplica a esta venta, no a una deuda anterior, y sincroniza su estado', async () => {
  const sale = { id: 'new-sale', customer_contact_id: 'customer-a', branch_id: 'branch-a', date: new Date(), reference: 'V-NEW', adjusted_total: 100, paymentEntries: [] }
  let paymentData
  let status
  const tx = {
    $executeRaw: async () => 1,
    paymentMethod: { findUnique: async () => ({ id: 2, is_credit: false }) },
    sale: {
      findMany: async () => [{ ...sale, id: 'old-sale', reference: 'OLD' }, sale],
      findUnique: async () => ({ ...sale, paymentEntries: [{ amount: 25 }] }),
      update: async ({ data }) => { status = data.payment_status },
    },
    customerPayment: { create: async ({ data }) => { paymentData = data; return { id: 'payment-a' } } },
  }
  const req = { user: { sub: 'cashier-a' }, body: { initial_payment: { amount: 25, payment_method_id: 2 } } }
  assert.equal(initialPaymentAmount(req.body, 100, true), 25)
  await recordInitialPayment(tx, req, sale, 25, 'session-a')
  assert.deepEqual(paymentData.applications.create, [{ sale_id: 'new-sale', amount: 25 }])
  assert.equal(paymentData.cash_register_session_id, 'session-a')
  assert.equal(status, 'PARTIAL')
  for (const amount of [-1, 0, 100, 101, 'abc', 25.001, true, []]) assert.throws(() => initialPaymentAmount({ initial_payment: { amount } }, 100, true))
  assert.throws(() => initialPaymentAmount(req.body, 100, false))
  await assert.rejects(recordInitialPayment(tx, req, sale, 25, null))
})
