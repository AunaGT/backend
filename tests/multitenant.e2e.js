/**

 * Uso: levantar un Postgres vacío, DATABASE_URL/DIRECT_URL apuntando a él,
 * npx prisma migrate deploy, y node tests/multitenant.e2e.js
 *
 * Prueba end-to-end del modelo multi-empresa + sucursales contra la BD desechable.
 * Verifica: aislamiento entre empresas, stock por sucursal, venta, traslado en
 * dos pasos, kits por sucursal y numeración por sucursal.
 */
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

const assert = (cond, msg) => {
  if (!cond) { console.error('FALLO:', msg); process.exitCode = 1; throw new Error(msg) }
  console.log('  ok:', msg)
}

async function main() {
  // --- Semillas de catálogos globales ---
  const [statusAct, stockStatus, saleStatus, payMethod, role] = await Promise.all([
    prisma.status.upsert({ where: { name: 'Activa' }, update: {}, create: { name: 'Activa' } }),
    prisma.stockStatus.upsert({ where: { name: 'Disponible' }, update: {}, create: { name: 'Disponible' } }),
    prisma.saleStatus.upsert({ where: { name: 'Completada' }, update: {}, create: { name: 'Completada' } }),
    prisma.paymentMethod.upsert({ where: { name: 'Efectivo' }, update: {}, create: { name: 'Efectivo' } }),
    prisma.role.upsert({ where: { name: 'Admin' }, update: {}, create: { name: 'Admin' } }),
  ])
  await prisma.status.upsert({ where: { name: 'Resuelta' }, update: {}, create: { name: 'Resuelta' } })
  for (const n of ['Sin Stock', 'Stock Bajo', 'Vencimiento']) {
    await prisma.alertType.upsert({ where: { name: n }, update: {}, create: { name: n } })
  }
  for (const n of ['Crítica', 'Alta', 'Media', 'Baja']) {
    await prisma.alertPriority.upsert({ where: { name: n }, update: {}, create: { name: n } })
  }

  console.log('\n== 1. Dos empresas con sus sucursales ==')
  const acme = await prisma.company.create({ data: { name: 'Acme', code: 'ACME' } })
  const globex = await prisma.company.create({ data: { name: 'Globex', code: 'GLBX' } })
  const acmeCentro = await prisma.branch.create({ data: { company_id: acme.id, name: 'Centro', code: 'CEN', is_default: true } })
  const acmeNorte = await prisma.branch.create({ data: { company_id: acme.id, name: 'Norte', code: 'NOR' } })
  const globexUno = await prisma.branch.create({ data: { company_id: globex.id, name: 'Uno', code: 'CEN' } })
  assert(acmeCentro.code === globexUno.code, 'dos empresas pueden reusar el mismo código de sucursal')
  assert(acmeCentro.seq !== acmeNorte.seq && acmeNorte.seq !== globexUno.seq, 'branch.seq es único global (lock keys)')

  const user = await prisma.user.create({
    data: { name: 'Diego', email: `d${Date.now()}@x.com`, password: 'h', role_id: role.id, default_branch_id: acmeCentro.id },
  })
  await prisma.userCompany.createMany({ data: [{ user_id: user.id, company_id: acme.id }, { user_id: user.id, company_id: globex.id }] })
  await prisma.userBranch.createMany({ data: [
    { user_id: user.id, branch_id: acmeCentro.id },
    { user_id: user.id, branch_id: acmeNorte.id },
    { user_id: user.id, branch_id: globexUno.id },
  ] })
  const memberships = await prisma.userBranch.count({ where: { user_id: user.id } })
  assert(memberships === 3, 'un usuario pertenece a varias empresas/sucursales (N a N)')

  console.log('\n== 2. Catálogo aislado por empresa ==')
  const catA = await prisma.productCategory.create({ data: { name: 'Licores', company_id: acme.id } })
  const catG = await prisma.productCategory.create({ data: { name: 'Licores', company_id: globex.id } })
  assert(catA.id !== catG.id, 'mismo nombre de categoría en dos empresas (unique por empresa)')

  const supA = await prisma.supplier.create({ data: { name: 'Prov A', contact: 'c', company_id: acme.id } })
  const supG = await prisma.supplier.create({ data: { name: 'Prov G', contact: 'c', company_id: globex.id } })

  const mk = (name, company, cat, sup, barcode) => prisma.product.create({
    data: {
      name, company_id: company.id, category_id: cat.id, supplier_id: sup.id,
      status_id: stockStatus.id, price: 100, cost: 60, stock: 0, min_stock: 5, barcode,
    },
  })
  const ron = await mk('Ron', acme, catA, supA, 'SHARED-BARCODE')
  const vodkaG = await mk('Vodka Globex', globex, catG, supG, 'SHARED-BARCODE')
  assert(ron.id !== vodkaG.id, 'mismo código de barras en dos empresas (unique por empresa)')

  const acmeProducts = await prisma.product.count({ where: { company_id: acme.id } })
  assert(acmeProducts === 1, 'el catálogo de Acme no ve productos de Globex')

  console.log('\n== 3. Stock por sucursal ==')
  // Entra por la puerta normal para que también aterrice en una ubicación real.
  const setStock = async (product, branch, stock, min = 5) => {
    const { restoreStockMap } = require('../src/services/bomStock')
    await prisma.$transaction(async (tx) => {
      await restoreStockMap(tx, new Map([[product.id, stock]]), branch.id, { reason: 'INITIAL' })
      await tx.productStock.update({
        where: { product_id_branch_id: { product_id: product.id, branch_id: branch.id } },
        data: { min_stock: min },
      })
    })
  }
  await setStock(ron, acmeCentro, 100)
  await setStock(ron, acmeNorte, 20)
  const ronAfter = await prisma.product.findUnique({ where: { id: ron.id } })
  assert(ronAfter.stock === 120, 'products.stock es el espejo (100 + 20 = 120)')
  const centroStock = await prisma.productStock.findUnique({
    where: { product_id_branch_id: { product_id: ron.id, branch_id: acmeCentro.id } },
  })
  assert(centroStock.stock === 100, 'Centro tiene su propio stock (100)')

  console.log('\n== 4. Venta descuenta solo la sucursal donde ocurre ==')
  const { deductStockMap, restoreStockMap } = require('../src/services/bomStock')
  const { nextDocumentReference } = require('../src/services/referenceGenerator')

  const saleRef = await prisma.$transaction(async (tx) => {
    const ref = await nextDocumentReference(tx, 'V', acmeCentro)
    await tx.sale.create({
      data: {
        branch_id: acmeCentro.id, reference: ref, total: 300, adjusted_total: 300, items: 3,
        payment_method_id: payMethod.id, status_id: saleStatus.id, created_by: user.id,
      },
    })
    await deductStockMap(tx, new Map([[ron.id, 3]]), acmeCentro.id)
    return ref
  })
  assert(saleRef === 'V-CEN-000001', `numeración por sucursal: ${saleRef}`)

  const [centroPost, nortePost, mirrorPost] = await Promise.all([
    prisma.productStock.findUnique({ where: { product_id_branch_id: { product_id: ron.id, branch_id: acmeCentro.id } } }),
    prisma.productStock.findUnique({ where: { product_id_branch_id: { product_id: ron.id, branch_id: acmeNorte.id } } }),
    prisma.product.findUnique({ where: { id: ron.id } }),
  ])
  assert(centroPost.stock === 97, 'la venta descontó Centro (100 → 97)')
  assert(nortePost.stock === 20, 'Norte quedó intacta (20)')
  assert(mirrorPost.stock === 117, 'el espejo bajó también (120 → 117)')

  // Numeración independiente por sucursal
  const norteRef = await prisma.$transaction(async (tx) => {
    const ref = await nextDocumentReference(tx, 'V', acmeNorte)
    await tx.sale.create({
      data: {
        branch_id: acmeNorte.id, reference: ref, total: 100, adjusted_total: 100, items: 1,
        payment_method_id: payMethod.id, status_id: saleStatus.id, created_by: user.id,
      },
    })
    return ref
  })
  assert(norteRef === 'V-NOR-000001', `cada sucursal numera desde 1: ${norteRef}`)

  console.log('\n== 5. Disponibilidad y reservas por sucursal ==')
  const { getAvailabilityBatch } = require('../src/services/stockAvailability')
  const availCentro = await getAvailabilityBatch([ron.id], null, { branchId: acmeCentro.id })
  const availNorte = await getAvailabilityBatch([ron.id], null, { branchId: acmeNorte.id })
  assert(availCentro[ron.id].available === 97, 'disponibilidad de Centro = 97')
  assert(availNorte[ron.id].available === 20, 'disponibilidad de Norte = 20')

  const doc = await prisma.commercialDocument.create({
    data: {
      branch_id: acmeCentro.id, doc_type: 'ORDER', status: 'CONFIRMED', total: 100,
      lines: { create: [{ product_id: ron.id, qty: 10, unit_price: 100, line_total: 1000 }] },
    },
    include: { lines: true },
  })
  await prisma.stockReservation.create({
    data: {
      product_id: ron.id, branch_id: acmeCentro.id, document_id: doc.id,
      document_line_id: doc.lines[0].id, qty: 10, status: 'ACTIVE',
    },
  })
  const availCentro2 = await getAvailabilityBatch([ron.id], null, { branchId: acmeCentro.id })
  const availNorte2 = await getAvailabilityBatch([ron.id], null, { branchId: acmeNorte.id })
  assert(availCentro2[ron.id].available === 87, 'la reserva de Centro descuenta solo en Centro (97 - 10)')
  assert(availNorte2[ron.id].available === 20, 'la reserva de Centro NO afecta a Norte')

  console.log('\n== 6. Traslado en dos pasos ==')
  const transfer = await prisma.$transaction(async (tx) => {
    const ref = await nextDocumentReference(tx, 'T', acmeCentro)
    const t = await tx.stockTransfer.create({
      data: {
        reference: ref, from_branch_id: acmeCentro.id, to_branch_id: acmeNorte.id,
        created_by: user.id, lines: { create: [{ product_id: ron.id, qty_sent: 12 }] },
      },
      include: { lines: true },
    })
    await deductStockMap(tx, new Map([[ron.id, 12]]), acmeCentro.id)
    return t
  })
  assert(transfer.reference === 'T-CEN-000001', `traslado numerado por sucursal: ${transfer.reference}`)

  let [c, n, m] = await Promise.all([
    prisma.productStock.findUnique({ where: { product_id_branch_id: { product_id: ron.id, branch_id: acmeCentro.id } } }),
    prisma.productStock.findUnique({ where: { product_id_branch_id: { product_id: ron.id, branch_id: acmeNorte.id } } }),
    prisma.product.findUnique({ where: { id: ron.id } }),
  ])
  assert(c.stock === 85, 'al enviar sale del origen (97 → 85)')
  assert(n.stock === 20, 'aún no entró al destino (sigue 20)')
  assert(m.stock === 105, 'en tránsito el espejo baja: no pertenece a ninguna sucursal')

  // Recepción parcial: llegan 10 de 12 (2 de merma)
  await prisma.$transaction(async (tx) => {
    await tx.stockTransferLine.update({ where: { id: transfer.lines[0].id }, data: { qty_received: 10 } })
    await restoreStockMap(tx, new Map([[ron.id, 10]]), acmeNorte.id)
    await tx.stockTransfer.update({
      where: { id: transfer.id },
      data: { status: 'RECIBIDA', received_by: user.id, received_at: new Date() },
    })
  })
  ;[c, n, m] = await Promise.all([
    prisma.productStock.findUnique({ where: { product_id_branch_id: { product_id: ron.id, branch_id: acmeCentro.id } } }),
    prisma.productStock.findUnique({ where: { product_id_branch_id: { product_id: ron.id, branch_id: acmeNorte.id } } }),
    prisma.product.findUnique({ where: { id: ron.id } }),
  ])
  assert(c.stock === 85, 'el origen no cambia al recibir')
  assert(n.stock === 30, 'el destino sumó lo recibido (20 → 30)')
  assert(m.stock === 115, 'el espejo refleja la merma de tránsito (2 unidades perdidas)')

  // Los lotes viajan con la mercancía: salen del origen y se recrean en destino
  console.log('\n== 6b. Lotes en traslados ==')
  const { consumeLotsForLocations, recreateLotsFromSnapshot } = require('../src/services/lots')
  const { defaultLocationId } = require('../src/services/stockLocations')
  const lotProd = await mk('Leche', acme, catA, supA, 'LECHE-1')
  await setStock(lotProd, acmeCentro, 20)
  const [centroLocation, norteLocation] = await prisma.$transaction(async (tx) => [
    await defaultLocationId(tx, acmeCentro.id), await defaultLocationId(tx, acmeNorte.id),
  ])
  await prisma.$transaction(async (tx) => {
    await tx.productLot.deleteMany({ where: { product_id: lotProd.id, branch_id: acmeCentro.id } })
    await tx.productLot.createMany({
      data: [
        { product_id: lotProd.id, branch_id: acmeCentro.id, location_id: centroLocation, lot_code: 'L-VIEJO', expiry_date: new Date('2026-09-01'), qty_received: 8, qty_remaining: 8 },
        { product_id: lotProd.id, branch_id: acmeCentro.id, location_id: centroLocation, lot_code: 'L-NUEVO', expiry_date: new Date('2026-12-01'), qty_received: 12, qty_remaining: 12 },
      ],
    })
  })

  const snapshot = await prisma.$transaction(async (tx) => {
    const consumed = await consumeLotsForLocations(tx, acmeCentro.id, [
      { product_id: lotProd.id, location_id: centroLocation, qty: 10 },
    ])
    return consumed.get(lotProd.id)
  })
  assert(snapshot.length === 2 && snapshot[0].lot_code === 'L-VIEJO' && snapshot[0].qty === 8,
    'al enviar salen los lotes más próximos a vencer primero (FEFO)')

  const centroLots = await prisma.productLot.findMany({
    where: { product_id: lotProd.id, branch_id: acmeCentro.id }, orderBy: { lot_code: 'asc' },
  })
  assert(centroLots.find((l) => l.lot_code === 'L-VIEJO').qty_remaining === 0 &&
    centroLots.find((l) => l.lot_code === 'L-NUEVO').qty_remaining === 10,
    'el origen queda sin el lote viejo y con 10 del nuevo')

  // Llegan 9 de 10: el faltante sale del último lote del snapshot
  await prisma.$transaction((tx) =>
    recreateLotsFromSnapshot(tx, lotProd.id, acmeNorte.id, snapshot, 9, norteLocation))
  const norteLots = await prisma.productLot.findMany({
    where: { product_id: lotProd.id, branch_id: acmeNorte.id }, orderBy: { lot_code: 'asc' },
  })
  assert(norteLots.length === 2, 'el destino recibe los dos lotes con su identidad')
  assert(norteLots.find((l) => l.lot_code === 'L-VIEJO').qty_remaining === 8 &&
    norteLots.find((l) => l.lot_code === 'L-NUEVO').qty_remaining === 1,
    'la merma de tránsito se descuenta del último lote (8 + 1 = 9 recibidas)')
  assert(norteLots.find((l) => l.lot_code === 'L-VIEJO').expiry_date.toISOString().slice(0, 10) === '2026-09-01',
    'la caducidad viaja con el lote')

  console.log('\n== 7. Kits por sucursal ==')
  const compA = await mk('Botella', acme, catA, supA, 'BOT-1')
  const compB = await mk('Caja', acme, catA, supA, 'CAJ-1')
  await setStock(compA, acmeCentro, 50)
  await setStock(compB, acmeCentro, 8)
  await setStock(compA, acmeNorte, 4)
  await setStock(compB, acmeNorte, 100)

  const kit = await prisma.product.create({
    data: {
      name: 'Combo', company_id: acme.id, category_id: catA.id, supplier_id: supA.id,
      status_id: stockStatus.id, price: 300, cost: 150, stock: 0, min_stock: 1, kind: 'KIT',
      kit_components: { create: [
        { component_product_id: compA.id, qty_per_unit: 2 },
        { component_product_id: compB.id, qty_per_unit: 1 },
      ] },
    },
  })

  const { getAvailabilityBatchWithKits, assembleKit } = require('../src/services/bomStock')
  const kitCentro = await getAvailabilityBatchWithKits([kit.id], null, acmeCentro.id)
  const kitNorte = await getAvailabilityBatchWithKits([kit.id], null, acmeNorte.id)
  assert(kitCentro[kit.id].available === 8, 'kit virtual en Centro: min(50/2, 8/1) = 8')
  assert(kitNorte[kit.id].available === 2, 'kit virtual en Norte: min(4/2, 100/1) = 2')

  const assembled = await prisma.$transaction((tx) => assembleKit(tx, kit.id, 3, acmeCentro.id))
  assert(assembled.qty === 3, 'se armaron 3 unidades en Centro')
  const [kitStockCentro, kitStockNorte, compACentro] = await Promise.all([
    prisma.productStock.findUnique({ where: { product_id_branch_id: { product_id: kit.id, branch_id: acmeCentro.id } } }),
    prisma.productStock.findUnique({ where: { product_id_branch_id: { product_id: kit.id, branch_id: acmeNorte.id } } }),
    prisma.productStock.findUnique({ where: { product_id_branch_id: { product_id: compA.id, branch_id: acmeCentro.id } } }),
  ])
  assert(kitStockCentro.stock === 3, 'el kit armado vive en Centro')
  assert(!kitStockNorte || kitStockNorte.stock === 0, 'Norte no recibió kits armados')
  assert(compACentro.stock === 44, 'se consumieron componentes de Centro (50 - 3*2)')

  console.log('\n== 8. Contabilidad y settings por empresa ==')
  await prisma.systemSetting.create({ data: { company_id: acme.id, key: 'currency_code', value: 'GTQ' } })
  await prisma.systemSetting.create({ data: { company_id: globex.id, key: 'currency_code', value: 'USD' } })
  const acmeCurrency = await prisma.systemSetting.findUnique({
    where: { company_id_key: { company_id: acme.id, key: 'currency_code' } },
  })
  assert(acmeCurrency.value === 'GTQ', 'cada empresa tiene su propia configuración con la misma clave')

  await prisma.account.create({ data: { company_id: acme.id, code: '1101', name: 'Caja', type: 'ASSET' } })
  await prisma.account.create({ data: { company_id: globex.id, code: '1101', name: 'Cash', type: 'ASSET' } })
  const acmeAccounts = await prisma.account.count({ where: { company_id: acme.id } })
  assert(acmeAccounts === 1, 'el catálogo de cuentas es por empresa (mismo código 1101 en ambas)')

  await prisma.journalEntry.create({
    data: { company_id: acme.id, entry_number: 'A-000001', date: new Date(), description: 'x', source_type: 'SALE', source_id: 's1' },
  })
  await prisma.journalEntry.create({
    data: { company_id: globex.id, entry_number: 'A-000001', date: new Date(), description: 'y', source_type: 'SALE', source_id: 's1' },
  })
  // Acotado a estas dos empresas: la base de pruebas la comparten varias suites
  // y un conteo global cuenta los asientos de las demás.
  const entries = await prisma.journalEntry.count({
    where: { company_id: { in: [acme.id, globex.id] } },
  })
  assert(entries === 2, 'la numeración e idempotencia de asientos es por empresa')

  console.log('\n== 9. Constraints de aislamiento ==')
  let blocked = false
  try {
    await prisma.product.create({
      data: {
        name: 'Duplicado', company_id: acme.id, category_id: catA.id, supplier_id: supA.id,
        status_id: stockStatus.id, price: 1, cost: 1, barcode: 'SHARED-BARCODE',
      },
    })
  } catch (e) { blocked = e.code === 'P2002' }
  assert(blocked, 'la BD rechaza un código de barras duplicado DENTRO de la misma empresa')

  blocked = false
  try {
    await prisma.sale.create({
      data: {
        branch_id: acmeCentro.id, reference: 'V-CEN-000001', total: 1, adjusted_total: 1, items: 1,
        payment_method_id: payMethod.id, status_id: saleStatus.id,
      },
    })
  } catch (e) { blocked = e.code === 'P2002' }
  assert(blocked, 'la BD rechaza una referencia de venta duplicada en la misma sucursal')

  console.log('\n== 10. Alcance de devoluciones, usuarios y asientos ==')
  // Devoluciones: viven en la sucursal de su venta.
  const retStatus = await prisma.returnStatus.upsert({
    where: { name: 'Pendiente' }, update: {}, create: { name: 'Pendiente' },
  })
  const saleCentro = await prisma.sale.findFirst({ where: { branch_id: acmeCentro.id, reference: 'V-CEN-000001' } })
  await prisma.return.create({
    data: {
      sale_id: saleCentro.id, status_id: retStatus.id, type: 'REFUND',
      total_refund: 100, reason: 'prueba', processed_by: user.id,
    },
  })
  const retsCentro = await prisma.return.count({ where: { sale: { branch_id: acmeCentro.id } } })
  const retsNorte = await prisma.return.count({ where: { sale: { branch_id: acmeNorte.id } } })
  assert(retsCentro === 1 && retsNorte === 0, 'la devolución solo se ve desde la sucursal de la venta')

  // Usuarios: el listado se filtra por empresa activa.
  const ajeno = await prisma.user.create({
    data: { name: 'Ajeno', email: `a${Date.now()}@x.com`, password: 'h', role_id: role.id },
  })
  await prisma.userCompany.create({ data: { user_id: ajeno.id, company_id: globex.id } })
  const usersAcme = await prisma.user.count({ where: { user_companies: { some: { company_id: acme.id } } } })
  const usersGlobex = await prisma.user.count({ where: { user_companies: { some: { company_id: globex.id } } } })
  assert(usersAcme === 1 && usersGlobex === 2, 'el listado de usuarios se filtra por empresa')

  // Asientos: guardan la sucursal de origen; los de empresa quedan en NULL.
  const { createEntry } = require('../src/services/accounting/core')
  const cuentaCaja = await prisma.account.findFirst({ where: { company_id: acme.id, code: '1101' } })
  const cuentaVenta = await prisma.account.create({
    data: { company_id: acme.id, code: '4101', name: 'Ventas', type: 'INCOME' },
  })
  const conSucursal = await prisma.$transaction((tx) =>
    createEntry(tx, {
      company_id: acme.id, branch_id: acmeCentro.id, date: new Date(), description: 'Venta Centro',
      lines: [
        { account_id: cuentaCaja.id, debit: 100, credit: 0 },
        { account_id: cuentaVenta.id, debit: 0, credit: 100 },
      ],
    }),
  )
  assert(conSucursal.branch_id === acmeCentro.id, 'el asiento guarda la sucursal que lo originó')
  const deEmpresa = await prisma.$transaction((tx) =>
    createEntry(tx, {
      company_id: acme.id, date: new Date(), description: 'Ajuste de empresa',
      lines: [
        { account_id: cuentaCaja.id, debit: 50, credit: 0 },
        { account_id: cuentaVenta.id, debit: 0, credit: 50 },
      ],
    }),
  )
  assert(deEmpresa.branch_id === null, 'un asiento sin sucursal es de empresa (NULL)')

  // Resultado por sucursal: la sucursal como centro de costo.
  const cuentaCosto = await prisma.account.create({
    data: { company_id: acme.id, code: '5101', name: 'Costo de ventas', type: 'COST' },
  })
  await prisma.$transaction((tx) =>
    createEntry(tx, {
      company_id: acme.id, branch_id: acmeNorte.id, date: new Date(), description: 'Venta Norte',
      lines: [
        { account_id: cuentaCaja.id, debit: 60, credit: 0 },
        { account_id: cuentaVenta.id, debit: 0, credit: 60 },
      ],
    }),
  )
  await prisma.$transaction((tx) =>
    createEntry(tx, {
      company_id: acme.id, branch_id: acmeCentro.id, date: new Date(), description: 'Costo Centro',
      lines: [
        { account_id: cuentaCosto.id, debit: 40, credit: 0 },
        { account_id: cuentaCaja.id, debit: 0, credit: 40 },
      ],
    }),
  )
  const reports = require('../src/controllers/accountingReports.controller')
  const porSucursal = await new Promise((resolve, reject) => {
    reports.byBranch(
      { companyId: acme.id, query: {} },
      { json: resolve },
      reject,
    )
  })
  const centroRow = porSucursal.branches.find((b) => b.branch_id === acmeCentro.id)
  const norteRow = porSucursal.branches.find((b) => b.branch_id === acmeNorte.id)
  const empresaRow = porSucursal.branches.find((b) => b.branch_id === null)
  assert(centroRow.income === 100 && centroRow.costs === 40 && centroRow.netIncome === 60,
    'Centro: ingresos 100, costo 40, utilidad 60')
  assert(norteRow.income === 60 && norteRow.netIncome === 60, 'Norte: ingresos 60, utilidad 60')
  assert(empresaRow.income === 50, 'el asiento sin sucursal se agrupa como "Empresa"')
  assert(porSucursal.totals.income === 210, 'el total de la empresa suma todas las sucursales (100+60+50)')

  // La configuración es de la empresa: nombre, logo, moneda y zona horaria
  console.log('\n== 11. Configuración por empresa ==')
  const { seedCompanySettings } = require('../src/services/companySettings')
  const { getSystemConfig, invalidateSystemConfigCache } = require('../src/utils/getTimezone')
  await prisma.$transaction((tx) => seedCompanySettings(tx, globex.id, { name: 'Globex', tax_id: '999' }))
  const globexSettings = await prisma.systemSetting.count({ where: { company_id: globex.id } })
  assert(globexSettings >= 19, `una empresa nueva nace configurada (${globexSettings} claves)`)

  await prisma.systemSetting.update({
    where: { company_id_key: { company_id: globex.id, key: 'timezone' } },
    data: { value: 'America/Mexico_City' },
  })
  invalidateSystemConfigCache()
  const cfgAcme = await getSystemConfig(prisma, acme.id)
  const cfgGlobex = await getSystemConfig(prisma, globex.id)
  assert(cfgGlobex.timezone === 'America/Mexico_City' && cfgAcme.timezone === 'America/Guatemala',
    'cada empresa resuelve su propia zona horaria')
  assert(cfgGlobex.company_name === 'Globex' && cfgAcme.company_name !== 'Globex',
    'cada empresa resuelve su propio nombre para PDFs y membretes')

  const sinEmpresa = await getSystemConfig(prisma, null)
  assert(sinEmpresa.company_name === 'Depósito' && sinEmpresa.timezone === 'America/Guatemala',
    'sin empresa se responden los valores por defecto, no los de otra empresa')

  console.log('\n== 12. Promociones y documentos por sucursal ==')
  // Llama un controller con req/res falsos: devuelve { status, body }.
  const callController = (fn, req) => new Promise((resolve, reject) => {
    let status = 200
    const res = {
      status(code) { status = code; return res },
      json(body) { resolve({ status, body }) },
    }
    Promise.resolve(fn(req, res, reject)).catch(reject)
  })

  const promoType = await prisma.promotionType.upsert({
    where: { name: 'PERCENTAGE' }, update: {}, create: { name: 'PERCENTAGE' },
  })
  const promoTodas = await prisma.promotion.create({
    data: {
      company_id: acme.id, name: 'Diez por ciento', type_id: promoType.id,
      discount_percentage: 10, applies_to_all: true, applies_to_all_branches: true,
      codes: { create: { company_id: acme.id, code: 'TODAS10' } },
    },
  })
  const promoNorte = await prisma.promotion.create({
    data: {
      company_id: acme.id, name: 'Solo Norte', type_id: promoType.id,
      discount_percentage: 20, applies_to_all: true, applies_to_all_branches: false,
      branches: { create: { branch_id: acmeNorte.id } },
      codes: { create: { company_id: acme.id, code: 'NORTE20' } },
    },
  })
  await prisma.promotion.create({
    data: {
      company_id: globex.id, name: 'Ajena', type_id: promoType.id,
      discount_percentage: 50, applies_to_all: true,
      codes: { create: { company_id: globex.id, code: 'AJENA50' } },
    },
  })

  const promos = require('../src/controllers/promotions.controller')
  const listaCentro = await callController(promos.list, {
    companyId: acme.id, branchId: acmeCentro.id, query: {},
  })
  const idsCentro = listaCentro.body.items.map((p) => p.id)
  assert(idsCentro.includes(promoTodas.id) && !idsCentro.includes(promoNorte.id),
    'en Centro solo se ven las promos que aplican ahí')

  const listaNorte = await callController(promos.list, {
    companyId: acme.id, branchId: acmeNorte.id, query: {},
  })
  const idsNorte = listaNorte.body.items.map((p) => p.id)
  assert(idsNorte.includes(promoTodas.id) && idsNorte.includes(promoNorte.id),
    'en Norte se ven la general y la suya')

  const consolidada = await callController(promos.list, {
    companyId: acme.id, branchId: null, branchIds: [acmeCentro.id, acmeNorte.id], query: {},
  })
  assert(consolidada.body.items.length === 2, 'la vista consolidada ve las dos promos de la empresa')

  const carrito = [{ product_id: (await prisma.product.findFirst({ where: { company_id: acme.id } })).id, price: 100, qty: 1 }]
  const valNorteEnCentro = await callController(promos.validateCode, {
    companyId: acme.id, branchId: acmeCentro.id, body: { code: 'NORTE20', items: carrito },
  })
  assert(valNorteEnCentro.body.valid === false, 'un código de otra sucursal no valida en Centro')

  const valNorteEnNorte = await callController(promos.validateCode, {
    companyId: acme.id, branchId: acmeNorte.id, body: { code: 'NORTE20', items: carrito },
  })
  assert(valNorteEnNorte.body.valid === true && valNorteEnNorte.body.discount === 20,
    'el mismo código sí valida en su sucursal (20% de 100)')

  const valAjena = await callController(promos.validateCode, {
    companyId: acme.id, branchId: acmeCentro.id, body: { code: 'AJENA50', items: carrito },
  })
  assert(valAjena.status === 404 && valAjena.body.valid === false,
    'un código de otra empresa no valida (fuga cerrada)')

  // Pedidos: sucursal explícita al crear y reasignación en borrador.
  const { targetBranch } = require('../src/middlewares/tenant')
  const reqCentro = { branchId: acmeCentro.id, userBranchIds: [acmeCentro.id, acmeNorte.id] }
  assert(targetBranch(reqCentro, null) === acmeCentro.id, 'sin sucursal explícita se usa la activa')
  assert(targetBranch(reqCentro, acmeNorte.id) === acmeNorte.id, 'se puede dirigir a otra sucursal propia')
  let denied = false
  try { targetBranch(reqCentro, globexUno.id) } catch (e) { denied = e.status === 403 }
  assert(denied, 'una sucursal ajena se rechaza con 403')

  const pedido = await prisma.commercialDocument.create({
    data: {
      branch_id: acmeCentro.id, reference: 'P-CEN-000001', doc_type: 'ORDER',
      status: 'DRAFT', total: 100, created_by: user.id,
    },
  })
  const orders = require('../src/controllers/orders.controller')
  const movido = await callController(orders.changeBranch, {
    params: { id: pedido.id }, body: { branch_id: acmeNorte.id },
    companyId: acme.id, branchId: acmeCentro.id,
    userBranchIds: [acmeCentro.id, acmeNorte.id],
  })
  assert(movido.body.branch_id === acmeNorte.id, 'el pedido en borrador se mueve de sucursal')
  assert(movido.body.reference.startsWith('P-NOR-'),
    `al mudarse toma el correlativo de la sucursal nueva (${movido.body.reference})`)

  await prisma.commercialDocument.update({ where: { id: pedido.id }, data: { status: 'CONFIRMED' } })
  const bloqueado = await callController(orders.changeBranch, {
    params: { id: pedido.id }, body: { branch_id: acmeCentro.id },
    companyId: acme.id, branchId: acmeNorte.id,
    userBranchIds: [acmeCentro.id, acmeNorte.id],
  })
  assert(bloqueado.status === 400, 'un pedido confirmado ya no se puede mover (tiene reservas)')

  // 13. Quitar un producto de una sucursal no lo quita de las demás.
  console.log('\n--- 13. Producto fuera de una sola sucursal ---')
  const products = require('../src/controllers/products.controller')
  const soloCentro = await mk('Solo Centro', acme, catA, supA, 'ONLY-CENTRO')
  await setStock(soloCentro, acmeCentro, 3, 0)
  await prisma.productStock.create({ data: { product_id: soloCentro.id, branch_id: acmeNorte.id, stock: 0 } })

  const conStock = await callController(products.removeFromBranch, {
    params: { id: soloCentro.id }, companyId: acme.id, branchId: acmeCentro.id,
  })
  assert(conStock.status === 400, 'con existencias no se puede quitar de la sucursal')

  const quitado = await callController(products.removeFromBranch, {
    params: { id: soloCentro.id }, companyId: acme.id, branchId: acmeNorte.id,
  })
  assert(quitado.body.ok === true, 'con stock en 0 sí se quita de la sucursal')

  const [enCentro, enNorte, sigueVivo] = await Promise.all([
    prisma.productStock.findUnique({ where: { product_id_branch_id: { product_id: soloCentro.id, branch_id: acmeCentro.id } } }),
    prisma.productStock.findUnique({ where: { product_id_branch_id: { product_id: soloCentro.id, branch_id: acmeNorte.id } } }),
    prisma.product.findUnique({ where: { id: soloCentro.id }, select: { deleted: true } }),
  ])
  assert(enNorte === null, 'la fila de Norte se borró')
  assert(enCentro && enCentro.stock === 3, 'Centro conserva su stock')
  assert(sigueVivo.deleted === false, 'el producto sigue existiendo en la empresa')

  // 14. Cambio de empresa: el header de empresa manda aunque la sucursal guardada
  // sea de la anterior (si no, /configuracion mostraba los datos de la otra).
  console.log('\n--- 14. Header de empresa sin sucursal ---')
  const { resolveTenant } = require('../src/middlewares/tenant')
  const jwt = require('jwt-simple')
  const moment = require('moment')
  const { secret } = require('../src/config/security')
  const token = jwt.encode(
    { sub: user.id, role: { name: role.name }, permissions: [], exp: moment().add(1, 'h').unix() },
    secret
  )
  const resolver = (headers) => new Promise((resolve) => {
    const req = { path: '/settings', method: 'GET', cookies: {}, headers: { authorization: `Bearer ${token}`, ...headers } }
    const res = {
      status(code) { this._s = code; return this },
      json(body) { resolve({ status: this._s || 200, body }) },
      send(body) { resolve({ status: this._s || 200, body }) },
    }
    resolveTenant(req, res, () => resolve({ req }))
  })

  const soloEmpresa = await resolver({ 'x-company-id': globex.id })
  assert(soloEmpresa.req && soloEmpresa.req.companyId === globex.id,
    'con solo el header de empresa se usa la sucursal del usuario en esa empresa')
  assert(soloEmpresa.req.branchId === globexUno.id, 'y esa sucursal es la suya, no la heredada')

  const sucursalAjena = await resolver({ 'x-company-id': globex.id, 'x-branch-id': acmeCentro.id })
  assert(sucursalAjena.status === 400, 'una sucursal explícita de otra empresa sigue siendo error')

  const sinHeaders = await resolver({})
  assert(sinHeaders.req.branchId === acmeCentro.id, 'sin headers se usa la sucursal por defecto')

  // 15. El reporte de inventario es del alcance pedido, no del catálogo entero.
  console.log('\n--- 15. Reporte de inventario por sucursal ---')
  const { inventoryReport } = require('../src/controllers/reports.controller')
  const csvReporte = (req) => new Promise((resolve, reject) => {
    const res = { setHeader() {}, status() { return res }, send: resolve, json: resolve }
    Promise.resolve(inventoryReport(req, res, reject)).catch(reject)
  })

  const csvCentro = await csvReporte({
    companyId: acme.id, branchId: acmeCentro.id, query: { format: 'csv' },
  })
  assert(csvCentro.includes('Solo Centro'), 'Centro sí lista el producto que maneja')

  const csvNorte = await csvReporte({
    companyId: acme.id, branchId: acmeNorte.id, query: { format: 'csv' },
  })
  assert(!csvNorte.includes('Solo Centro'), 'Norte no lista un producto que no maneja')

  const csvTodas = await csvReporte({
    companyId: acme.id, branchId: null, branchIds: [acmeCentro.id, acmeNorte.id], query: { format: 'csv' },
  })
  assert(csvTodas.includes('Solo Centro') && csvTodas.includes('Inventario por Sucursal'),
    'el consolidado lo incluye y desglosa por sucursal')

  console.log('\nTODAS LAS PRUEBAS PASARON')
}

main()
  .catch((e) => { console.error('\nERROR:', e.message); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
