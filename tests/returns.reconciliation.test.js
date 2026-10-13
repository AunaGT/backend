const test = require('node:test')
const assert = require('node:assert/strict')

const { applyReturnSettlements } = require('../src/modules/cash-closure/domain')
const { buildReturnPosting } = require('../src/services/accounting/postingEngine')
const { returnFiscalStatus } = require('../src/modules/returns/domain')

test('caja usa liquidaciones reales de la sesión y no el acumulado de la venta', () => {
  const methods = new Map([[1, {
    id: 1, name: 'Efectivo', theoretical_amount: 500, theoretical_count: 2, sales: [],
  }]])
  const totals = applyReturnSettlements(methods, [
    { kind: 'REFUND', amount: 30, payment_method_id: 1, payment_method: { name: 'Efectivo' } },
    { kind: 'COLLECTION', amount: 25, payment_method_id: 1, payment_method: { name: 'Efectivo' } },
    { kind: 'CREDIT_OFFSET', amount: 100, payment_method_id: null, payment_method: null },
    { kind: 'CUSTOMER_CREDIT', amount: 20, payment_method_id: null, payment_method: null },
  ])
  assert.deepEqual(totals, { refunds: 30, collections: 25 })
  assert.equal(methods.get(1).theoretical_amount, 495)
  assert.equal(methods.get(1).theoretical_count, 4)
})

test('posteo separa salida real, compensación de cartera y stock apto', () => {
  const accounts = {
    salesReturns: { id: 1 }, ivaDebit: { id: 2 }, cash: { id: 3 }, bank: { id: 4 },
    receivables: { id: 5 }, inventory: { id: 6 }, cogs: { id: 7 },
    pequenoTax: { id: 8 }, pequenoTaxExpense: { id: 9 },
  }
  const lines = buildReturnPosting({
    total_refund: 100,
    type: 'REFUND',
    sale: { payment_method: { name: 'Efectivo', is_credit: false } },
    settlements: [
      { kind: 'CREDIT_OFFSET', amount: 40, payment_method: null },
      { kind: 'REFUND', amount: 60, payment_method: { name: 'Transferencia', is_credit: false } },
    ],
    return_items: [
      { restock_qty: 2, sale_item: { unit_cost: 10 }, product: { cost: 99 } },
      { restock_qty: 0, sale_item: { unit_cost: 50 }, product: { cost: 99 } },
    ],
  }, {
    defaults: accounts,
    splitVat: false,
    ivaRate: 0.12,
    costBase: (value) => value,
    pequenoTaxOf: () => 0,
  })

  assert.deepEqual(lines, [
    { account_id: 1, debit: 100, credit: 0 },
    { account_id: 5, debit: 0, credit: 40 },
    { account_id: 4, debit: 0, credit: 60 },
    { account_id: 6, debit: 20, credit: 0 },
    { account_id: 7, debit: 0, credit: 20 },
  ])
})

test('un cambio revierte contra el medio original y deja la diferencia a venta vinculada', () => {
  const defaults = {
    salesReturns: { id: 1 }, ivaDebit: { id: 2 }, cash: { id: 3 }, bank: { id: 4 },
    receivables: { id: 5 }, inventory: { id: 6 }, cogs: { id: 7 },
    pequenoTax: { id: 8 }, pequenoTaxExpense: { id: 9 },
  }
  const lines = buildReturnPosting({
    total_refund: 100,
    type: 'EXCHANGE',
    sale: { payment_method: { name: 'Efectivo', is_credit: false } },
    settlements: [{ kind: 'COLLECTION', amount: 25, payment_method: { name: 'Efectivo' } }],
    return_items: [],
  }, {
    defaults, splitVat: false, ivaRate: 0.12, costBase: (value) => value, pequenoTaxOf: () => 0,
  })
  assert.deepEqual(lines, [
    { account_id: 1, debit: 100, credit: 0 },
    { account_id: 3, debit: 0, credit: 100 },
  ])
})

test('una venta con DTE muestra obligación fiscal sin emitir una nota automáticamente', () => {
  assert.deepEqual(returnFiscalStatus([
    { id: 'dte-1', status: 'autorizado', authorization: 'AUTH-1', series: 'A', number: '10' },
  ]), {
    requires_credit_note: true,
    status: 'PENDING_EXTERNAL_CREDIT_NOTE',
    original_documents: [{ id: 'dte-1', authorization: 'AUTH-1', series: 'A', number: '10' }],
  })
  assert.deepEqual(returnFiscalStatus([]), {
    requires_credit_note: false,
    status: 'NOT_APPLICABLE',
    original_documents: [],
  })
})
