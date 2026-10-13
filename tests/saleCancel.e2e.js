/**
 * Cancelar una venta devuelve al inventario lo que el cliente todavía tiene, no
 * la venta completa: lo ya devuelto volvió cuando se aprobó la devolución.
 *
 * Uso: contra un Postgres desechable ya migrado.
 */
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

const assert = (cond, msg) => {
  if (!cond) { console.error('FALLO:', msg); process.exitCode = 1; throw new Error(msg) }
  console.log('  ok:', msg)
}

const callController = (fn, req) => new Promise((resolve, reject) => {
  let status = 200
  const res = { status(code) { status = code; return res }, json(body) { resolve({ status, body }) } }
  Promise.resolve(fn(req, res, reject)).catch(reject)
})

async function main() {
  const [stockStatus, role, payMethod] = await Promise.all([
    prisma.stockStatus.upsert({ where: { name: 'Disponible' }, update: {}, create: { name: 'Disponible' } }),
    prisma.role.upsert({ where: { name: 'Admin' }, update: {}, create: { name: 'Admin' } }),
    prisma.paymentMethod.upsert({ where: { name: 'Efectivo' }, update: {}, create: { name: 'Efectivo' } }),
  ])
  for (const n of ['Completada', 'Cancelada']) {
    await prisma.saleStatus.upsert({ where: { name: n }, update: {}, create: { name: n } })
  }
  for (const n of ['Sin Stock', 'Stock Bajo']) {
    await prisma.alertType.upsert({ where: { name: n }, update: {}, create: { name: n } })
  }
  for (const n of ['Crítica', 'Alta', 'Media', 'Baja']) {
    await prisma.alertPriority.upsert({ where: { name: n }, update: {}, create: { name: n } })
  }
  await prisma.status.upsert({ where: { name: 'Activa' }, update: {}, create: { name: 'Activa' } })
  await prisma.status.upsert({ where: { name: 'Resuelta' }, update: {}, create: { name: 'Resuelta' } })

  const { restoreStockMap } = require('../src/services/bomStock')
  const sales = require('../src/modules/sales/controller')

  const co = await prisma.company.create({ data: { name: 'Cancelaciones SA', code: `CX${Date.now() % 100000}` } })
  const suc = await prisma.branch.create({ data: { company_id: co.id, name: 'Central', code: 'CTR', is_default: true } })
  const user = await prisma.user.create({
    data: { name: 'Cajero', email: `c${Date.now()}@x.com`, password: 'h', role_id: role.id, default_branch_id: suc.id },
  })
  const cat = await prisma.productCategory.create({ data: { name: 'Licores', company_id: co.id } })
  const sup = await prisma.supplier.create({ data: { name: 'Prov', contact: 'c', company_id: co.id } })
  const ron = await prisma.product.create({
    data: {
      name: 'Ron', company_id: co.id, category_id: cat.id, supplier_id: sup.id,
      status_id: stockStatus.id, price: 100, cost: 60, stock: 0, min_stock: 0,
    },
  })
  await prisma.$transaction((tx) => restoreStockMap(tx, new Map([[ron.id, 10]]), suc.id, { reason: 'PURCHASE' }))

  const completada = await prisma.saleStatus.findUnique({ where: { name: 'Completada' } })
  const cancelada = await prisma.saleStatus.findUnique({ where: { name: 'Cancelada' } })

  // Venta de 5 registrada a mano (el POS exige caja abierta; acá interesa el stock).
  const venta = await prisma.sale.create({
    data: {
      branch_id: suc.id, reference: `V-CTR-${Date.now() % 900000}`, customer: 'Cliente',
      items: 5, subtotal: 500, total: 500, adjusted_total: 500,
      payment_method_id: payMethod.id, status_id: completada.id, created_by: user.id,
      sale_items: { create: [{ product_id: ron.id, price: 100, qty: 5 }] },
    },
    include: { sale_items: true },
  })
  const { deductStockMap } = require('../src/services/bomStock')
  await prisma.$transaction((tx) => deductStockMap(tx, new Map([[ron.id, 5]]), suc.id, {
    reason: 'SALE', refType: 'sale', refId: venta.id,
  }))

  const trasVender = await prisma.productStock.findUnique({
    where: { product_id_branch_id: { product_id: ron.id, branch_id: suc.id } },
  })
  assert(trasVender.stock === 5, 'compró 10, vendió 5, quedan 5')

  console.log('\n== Devolución parcial de 2 ==')
  const devuelta = await prisma.returnStatus.upsert({
    where: { name: 'Aprobada' }, update: {}, create: { name: 'Aprobada' },
  })
  const dev = await prisma.return.create({
    data: {
      sale_id: venta.id, status_id: devuelta.id, reason: 'Producto dañado',
      total_refund: 200, processed_by: user.id,
      return_items: {
        create: [{ sale_item_id: venta.sale_items[0].id, product_id: ron.id, qty_returned: 2, refund_amount: 200 }],
      },
    },
  })
  await prisma.$transaction((tx) => restoreStockMap(tx, new Map([[ron.id, 2]]), suc.id, {
    reason: 'SALE_RETURN', refType: 'return', refId: dev.id,
  }))
  const trasDevolver = await prisma.productStock.findUnique({
    where: { product_id_branch_id: { product_id: ron.id, branch_id: suc.id } },
  })
  assert(trasDevolver.stock === 7, 'la devolución de 2 deja 7')

  console.log('\n== Cancelación de la venta ==')
  const res = await callController(sales.updateStatus, {
    params: { id: venta.id },
    body: { status_id: cancelada.id },
    companyId: co.id, branchId: suc.id, user: { sub: user.id },
    query: {},
  })
  assert(res.status === 200 || res.status === undefined, `la cancelación responde ok (${res.status})`)

  const final = await prisma.productStock.findUnique({
    where: { product_id_branch_id: { product_id: ron.id, branch_id: suc.id } },
  })
  assert(final.stock === 10,
    `vuelve a 10 (compradas), no a 12: solo se devuelven las 3 que el cliente tenía — quedó en ${final.stock}`)

  const empresa = await prisma.product.findUnique({ where: { id: ron.id }, select: { stock: true } })
  assert(empresa.stock === 10, 'y el espejo de empresa también')

  console.log('\nTODAS LAS PRUEBAS PASARON')
}

main().catch((e) => { console.error(e); process.exitCode = 1 }).finally(() => prisma.$disconnect())
