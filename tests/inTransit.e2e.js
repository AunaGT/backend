/**
 * La mercancía enviada y no recibida deja de estar en los anaqueles pero sigue
 * siendo de la empresa: el reporte financiero la vuelve a sumar en vez de
 * dejarla desaparecer entre el envío y la recepción.
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
  const [stockStatus, role] = await Promise.all([
    prisma.stockStatus.upsert({ where: { name: 'Disponible' }, update: {}, create: { name: 'Disponible' } }),
    prisma.role.upsert({ where: { name: 'Admin' }, update: {}, create: { name: 'Admin' } }),
  ])
  for (const n of ['Sin Stock', 'Stock Bajo']) {
    await prisma.alertType.upsert({ where: { name: n }, update: {}, create: { name: n } })
  }
  for (const n of ['Crítica', 'Alta', 'Media', 'Baja']) {
    await prisma.alertPriority.upsert({ where: { name: n }, update: {}, create: { name: n } })
  }
  for (const n of ['Activa', 'Resuelta']) {
    await prisma.status.upsert({ where: { name: n }, update: {}, create: { name: n } })
  }

  const { restoreStockMap } = require('../src/services/bomStock')
  const { inTransitTotals } = require('../src/services/inTransit')
  const { getFinancialData } = require('../src/modules/reports/controller')
  const transfers = require('../src/modules/transfers/controller')

  const co = await prisma.company.create({ data: { name: 'Tránsito SA', code: `TR${Date.now() % 100000}` } })
  const origen = await prisma.branch.create({ data: { company_id: co.id, name: 'Central', code: 'CTR', is_default: true } })
  const destino = await prisma.branch.create({ data: { company_id: co.id, name: 'Norte', code: 'NOR' } })
  const user = await prisma.user.create({
    data: { name: 'Bodeguero', email: `t${Date.now()}@x.com`, password: 'h', role_id: role.id, default_branch_id: origen.id },
  })
  const cat = await prisma.productCategory.create({ data: { name: 'Licores', company_id: co.id } })
  const sup = await prisma.supplier.create({ data: { name: 'Prov', contact: 'c', company_id: co.id } })
  const ron = await prisma.product.create({
    data: {
      name: 'Ron', company_id: co.id, category_id: cat.id, supplier_id: sup.id,
      status_id: stockStatus.id, price: 100, cost: 25, stock: 0, min_stock: 0,
    },
  })
  await prisma.$transaction((tx) => restoreStockMap(tx, new Map([[ron.id, 20]]), origen.id, { reason: 'PURCHASE' }))

  const catalogo = () => prisma.product.findMany({
    where: { company_id: co.id, deleted: false }, select: { id: true, stock: true, cost: true },
  })
  const enTransito = (branchIds = []) => catalogo().then((ps) => inTransitTotals(co.id, ps, { branchIds }))
  const espejoEmpresa = async () =>
    Number((await prisma.product.findUnique({ where: { id: ron.id }, select: { stock: true } })).stock)

  assert(await espejoEmpresa() === 20, 'la empresa arranca con 20 unidades')
  assert((await enTransito()).units === 0, 'y nada en tránsito')

  console.log('\n== 1. Se envían 6 unidades a la otra sucursal ==')
  const envio = await callController(transfers.create, {
    companyId: co.id, branchId: origen.id, user: { sub: user.id },
    body: { to_branch_id: destino.id, items: [{ product_id: ron.id, qty: 6 }] },
  })
  assert(envio.status === 201, `el traslado sale (${envio.status}) ${JSON.stringify(envio.body).slice(0, 150)}`)

  assert(await espejoEmpresa() === 14, 'el espejo de empresa baja a 14: las 6 no están en ningún anaquel')
  const transito = await enTransito()
  assert(transito.units === 6, `pero el tránsito las tiene — reportó ${transito.units}`)
  assert(transito.value === 150, `valoradas a 6 × 25 = 150 — reportó ${transito.value}`)

  console.log('\n== 2. El reporte financiero suma lo que la empresa posee ==')
  const req = { companyId: co.id, branchIds: [origen.id, destino.id], query: {} }
  const desde = new Date(Date.now() - 86400000)
  const hasta = new Date(Date.now() + 86400000)
  let fin = await getFinancialData(desde, hasta, req)
  assert(fin.inventoryValue === 350, `en anaqueles: 14 × 25 = 350 — reportó ${fin.inventoryValue}`)
  assert(fin.inTransitValue === 150, `en tránsito: 150 — reportó ${fin.inTransitValue}`)
  assert(fin.inventoryValueOwned === 500,
    `propiedad de la empresa: 500, lo mismo que antes de enviar — reportó ${fin.inventoryValueOwned}`)

  console.log('\n== 3. La sucursal que envió responde por lo que mandó ==')
  assert((await enTransito([origen.id])).units === 6, 'el reporte de la origen cuenta sus envíos pendientes')
  assert((await enTransito([destino.id])).units === 0, 'el de la destino no: todavía no lo recibe')

  console.log('\n== 4. Al recibir, el tránsito se vacía ==')
  const recibo = await callController(transfers.receive, {
    params: { id: envio.body.id },
    companyId: co.id, branchId: destino.id, user: { sub: user.id }, body: {},
  })
  assert(recibo.status === 200 || recibo.status === undefined, `la recepción responde ok (${recibo.status})`)
  assert(await espejoEmpresa() === 20, 'la empresa vuelve a tener sus 20 en anaqueles')
  assert((await enTransito()).units === 0, 'y el tránsito queda en cero')

  fin = await getFinancialData(desde, hasta, req)
  assert(fin.inventoryValueOwned === 500 && fin.inTransitValue === 0,
    'el total propiedad de la empresa no se movió en todo el viaje')

  console.log('\n== 5. Un traslado cancelado tampoco queda en tránsito ==')
  const otro = await callController(transfers.create, {
    companyId: co.id, branchId: origen.id, user: { sub: user.id },
    body: { to_branch_id: destino.id, items: [{ product_id: ron.id, qty: 3 }] },
  })
  assert((await enTransito()).units === 3, 'mientras viaja, cuenta')
  const cancelado = await callController(transfers.cancel, {
    params: { id: otro.body.id },
    companyId: co.id, branchId: origen.id, user: { sub: user.id },
  })
  assert(cancelado.status === 200 || cancelado.status === undefined, `la cancelación responde ok (${cancelado.status})`)
  assert((await enTransito()).units === 0, 'cancelado deja de contar como tránsito')
  assert(await espejoEmpresa() === 20, 'y las unidades volvieron al origen')

  console.log('\nTODAS LAS PRUEBAS PASARON')
}

main().catch((e) => { console.error(e); process.exitCode = 1 }).finally(() => prisma.$disconnect())
