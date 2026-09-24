const test = require('node:test')
const assert = require('node:assert/strict')
const { selectLines, requestKey, invoice } = require('../src/modules/orders/fulfillment')

const lines = [{ id: 'line-1', product_id: 'product-1', qty: 10, qty_fulfilled: 6, qty_invoiced: 2, unit_price: 12.5 }]
test('entrega y factura tienen pendientes independientes', () => {
  assert.equal(selectLines(lines, [{ line_id: 'line-1', qty: 4 }])[0].qty, 4)
  assert.equal(selectLines(lines, [{ line_id: 'line-1', qty: 4 }], true)[0].qty, 4)
  assert.throws(() => selectLines(lines, [{ line_id: 'line-1', qty: 5 }]), /supera pendiente/)
  assert.throws(() => selectLines(lines, [{ line_id: 'line-1', qty: 5 }], true), /supera pendiente/)
  const delivered = [{ ...lines[0], qty_fulfilled: 10 }]
  assert.equal(selectLines(delivered, [{ line_id: 'line-1', qty: 8 }], true)[0].qty, 8)
  assert.throws(() => selectLines(delivered, [{ line_id: 'line-1', qty: 1 }]), /supera pendiente/)
})
test('rechaza partidas vacías, duplicadas, ajenas y cantidades fraccionarias', () => {
  for (const raw of [undefined, [], {}, [null], [{ line_id: 'line-1', qty: 0 }], [{ line_id: 'line-1', qty: 0.5 }], [{ line_id: 'line-1', qty: '1' }], [{ line_id: 'line-1', qty: 1 }, { line_id: 'line-1', qty: 1 }], [{ line_id: 'other', qty: 1 }]]) {
    assert.throws(() => selectLines(lines, raw))
  }
  assert.throws(() => requestKey('invalid'))
})

const key = 'b73abc4a-041e-4ce0-baa6-d38cc18aaeee'
function fixture() {
  const events = []
  const order = { id: 'order-1', fulfillment_mode: 'SEPARATE', status: 'FULFILLED', branch_id: 'branch-1', lines }
  let existing = null
  const tx = {
    $queryRaw: async (strings, ...values) => { events.push(['lock', values]); return [{ id: order.id }] },
    commercialDocument: { findUnique: async () => { events.push(['load']); return order } },
    sale: {
      findFirst: async () => existing,
      create: async ({ data }) => { events.push(['sale', data]); existing = { id: 'sale-1', ...data, orderLink: { document_id: order.id } }; return existing },
    },
    paymentMethod: { findUnique: async () => ({ id: 1, is_credit: false }) },
    saleStatus: { findFirst: async () => ({ id: 1 }) },
    branch: { findUnique: async () => ({ id: 'branch-1', code: 'A', seq: 1 }) },
    product: { findMany: async () => [{ id: 'product-1', cost: 3 }] },
    orderDeliveryLine: {
      findMany: async () => [{ id: 'delivery-line-1', document_line_id: 'line-1', qty: 6, qty_invoiced: 2, unit_cost: 2 }],
      update: async () => ({}),
    },
    commercialDocumentLine: { update: async args => { events.push(['line', args]); return {} } },
    $executeRaw: async () => 1,
  }
  const req = { params: { id: 'order-1' }, companyId: 'company-1', branchId: 'branch-1', user: { sub: 'user-1' },
    body: { request_key: key, lines: [{ line_id: 'line-1', qty: 4 }], payment_method_id: 1 } }
  return { tx, req, order, events, setExisting: value => { existing = value } }
}
test('consulta tenant y sucursal bajo bloqueo antes de leer cantidades', async () => {
  const { tx, req, events } = fixture()
  tx.$queryRaw = async (strings, ...values) => { events.push(values); return [] }
  await assert.rejects(invoice(tx, req, async () => null), /no encontrado/)
  assert.deepEqual(events[0], ['order-1', 'order-1', 'company-1', 'branch-1'])
})
test('reintento retorna la misma venta sin facturar ni mover inventario de nuevo', async () => {
  const { tx, req, events, setExisting } = fixture()
  setExisting({ id: 'sale-1', orderLink: { document_id: 'order-1' } })
  const result = await invoice(tx, req, async () => { throw new Error('No debe abrir caja') })
  assert.equal(result.sale.id, 'sale-1')
  assert.deepEqual(events.map(event => event[0]), ['lock', 'load'])
})
test('clave de otra venta y flujo legacy no se reutilizan', async () => {
  const f = fixture()
  f.setExisting({ id: 'sale-2', orderLink: null })
  await assert.rejects(invoice(f.tx, f.req, async () => null), /otra venta/)
  f.order.fulfillment_mode = 'LEGACY'
  await assert.rejects(invoice(f.tx, f.req, async () => null), /flujo anterior/)
})

test('facturar 4 unidades entregadas crea una venta por 50 sin operaciones de stock', async () => {
  const { tx, req, events } = fixture()
  const result = await invoice(tx, req, async () => 'session-1')
  assert.equal(result.sale.total, 50)
  assert.equal(result.sale.payment_status, 'PAID')
  assert.equal(result.sale.cash_register_session_id, 'session-1')
  assert.equal(result.sale.sale_items.create[0].unit_cost, 2)
  assert.equal(result.sale.orderLink.document_id, 'order-1')
  assert.deepEqual(events.find(event => event[0] === 'line')[1].data, { qty_invoiced: { increment: 4 } })
  assert.deepEqual(events.map(event => event[0]), ['lock', 'load', 'sale', 'line'])
})
