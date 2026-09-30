const test = require('node:test')
const assert = require('node:assert/strict')

const {
  createReplacementSale,
  exchangeDifference,
  exchangeSettlement,
  resolvePricedSaleItems,
} = require('../src/modules/sales/application')

function pricingTx() {
  return {
    product: {
      findMany: async () => [
        {
          id: 'product-1', name: 'Producto', company_id: 'company-1', available_for_sale: true,
          price: 125, price_wholesale: 110, price_promotion: null, promotion_valid_until: null, cost: 60,
        },
      ],
    },
    supplier: { findFirst: async () => null },
  }
}

const availability = async () => ({ 'product-1': { available: 3, stock: 3, reserved: 0 } })

test('un cambio calcula únicamente la diferencia real', () => {
  assert.deepEqual(exchangeDifference(100, 100), { amount: 0, direction: 'NONE' })
  assert.deepEqual(exchangeDifference(100, 130), { amount: 30, direction: 'COLLECTION' })
  assert.deepEqual(exchangeDifference(100, 70), { amount: 30, direction: 'REFUND' })
})

test('una diferencia negativa puede quedar como saldo a favor solo con cliente identificado', () => {
  assert.deepEqual(exchangeSettlement({
    difference: { amount: 30, direction: 'REFUND' },
    channel: 'CUSTOMER_CREDIT',
    hasCustomer: true,
  }), { kind: 'CUSTOMER_CREDIT', amount: 30, requiresDirectMethod: false })
  assert.throws(() => exchangeSettlement({
    difference: { amount: 30, direction: 'REFUND' },
    channel: 'CUSTOMER_CREDIT',
    hasCustomer: false,
  }), /cliente maestro/i)
})

test('el servidor resuelve precios vigentes y rechaza precios enviados por el navegador', async () => {
  const tx = pricingTx()
  const resolved = await resolvePricedSaleItems(tx, {
    items: [{ product_id: 'product-1', qty: 2 }],
    branchId: 'branch-1', companyId: 'company-1', availability,
  })
  assert.deepEqual(resolved, [{
    product_id: 'product-1', qty: 2, unit_price: 125, line_total: 250, unit_cost: 60,
  }])
  await assert.rejects(() => resolvePricedSaleItems(tx, {
    items: [{ product_id: 'product-1', qty: 1, unit_price: 1 }],
    branchId: 'branch-1', companyId: 'company-1', availability,
  }), /precio.*navegador/i)
})

test('precio histórico se usa solo para el mismo producto y stock insuficiente no escribe', async () => {
  const tx = pricingTx()
  const historical = await resolvePricedSaleItems(tx, {
    items: [{ product_id: 'product-1', qty: 1 }],
    branchId: 'branch-1', companyId: 'company-1', pricing: 'ORIGINAL_SALE_PRICE',
    originalSaleItems: [{ product_id: 'product-1', qty: 2, price: 100, net_total: 180 }],
    availability,
  })
  assert.equal(historical[0].unit_price, 90)
  await assert.rejects(() => resolvePricedSaleItems(tx, {
    items: [{ product_id: 'product-1', qty: 4 }],
    branchId: 'branch-1', companyId: 'company-1', availability,
  }), /stock insuficiente/i)
})

test('una sucursal ajena queda fuera por el filtro tenant de productos', async () => {
  const tx = pricingTx()
  let where
  tx.product.findMany = async (query) => { where = query.where; return [] }
  await assert.rejects(() => resolvePricedSaleItems(tx, {
    items: [{ product_id: 'product-1', qty: 1 }],
    branchId: 'branch-other', companyId: 'company-1', availability,
  }), /no encontrado/i)
  assert.equal(where.company_id, 'company-1')
})

test('crea una sola venta vinculada y mueve inventario una sola vez', async () => {
  const created = []
  let stockMoves = 0
  const tx = pricingTx()
  tx.saleStatus = { findFirst: async () => ({ id: 1 }) }
  tx.branch = { findUnique: async () => ({ id: 'branch-1', code: 'Z1', seq: 1 }) }
  tx.sale = {
    findUnique: async ({ where }) => created.find((sale) => sale.id === where.id) || null,
    create: async ({ data }) => {
      const sale = { id: 'replacement-sale', ...data }
      created.push(sale)
      return sale
    },
  }
  tx.saleItem = { createMany: async () => ({ count: 1 }) }
  tx.return = {
    update: async ({ data }) => { exchange.replacement_sale_id = data.replacement_sale_id; return exchange },
  }
  tx.$executeRaw = async () => 1
  tx.return = {
    ...tx.return,
    findFirst: async () => null,
  }
  const exchange = {
    id: 'return-1', reference: 'D-Z1-000001', total_refund: 100, replacement_sale_id: null,
    sale: {
      id: 'sale-1', branch_id: 'branch-1', customer: 'Ana', customer_nit: 'CF', is_final_consumer: false,
      customer_contact_id: null, sales_channel: 'POS', payment_method_id: 1,
      sale_items: [{ product_id: 'product-1', qty: 1, price: 100, net_total: 100 }],
    },
  }
  const params = {
    returnRecord: exchange,
    replacements: [{ product_id: 'product-1', qty: 1 }],
    companyId: 'company-1', userId: 'user-1', pricing: 'CURRENT_PRICE',
  }
  const deps = {
    availability,
    nextReference: async () => 'V-Z1-000002',
    moveStock: async () => { stockMoves++; return [] },
  }

  const first = await createReplacementSale(tx, params, deps)
  const second = await createReplacementSale(tx, params, deps)
  assert.equal(first.sale.id, 'replacement-sale')
  assert.equal(first.total, 125)
  assert.deepEqual(first.difference, { amount: 25, direction: 'COLLECTION' })
  assert.equal(second.sale.id, 'replacement-sale')
  assert.equal(created.length, 1)
  assert.equal(stockMoves, 1)
})
