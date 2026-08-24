/**
 * Uso: levantar un Postgres vacío, DATABASE_URL/DIRECT_URL apuntando a él,
 * npx prisma migrate deploy, y node tests/locations.e2e.js
 *
 * Stock por ubicación (fases 0 y 1 del plan de almacenes): la sucursal nace con
 * su almacén por defecto, la salida se reparte por prioridad de despacho, el
 * libro de movimientos cuadra con las existencias y los tres niveles
 * (empresa / sucursal / ubicación) nunca se separan.
 */
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

const assert = (cond, msg) => {
  if (!cond) { console.error('FALLO:', msg); process.exitCode = 1; throw new Error(msg) }
  console.log('  ok:', msg)
}

const callController = (fn, req) => new Promise((resolve, reject) => {
  let status = 200
  const res = {
    status(code) { status = code; return res },
    json(body) { resolve({ status, body }) },
  }
  Promise.resolve(fn(req, res, reject)).catch(reject)
})

/** Existencias por código de ubicación, para afirmar sobre ellas cómodamente. */
async function stockByLocation(branchId, productId) {
  const rows = await prisma.$queryRawUnsafe(`
    SELECT l.code, psl.stock
    FROM product_stock_locations psl
    JOIN stock_locations l ON l.id = psl.location_id
    JOIN warehouses w ON w.id = l.warehouse_id
    WHERE w.branch_id = $1::uuid AND psl.product_id = $2::uuid
  `, branchId, productId)
  return Object.fromEntries(rows.map((r) => [r.code, Number(r.stock)]))
}

async function main() {
  const [stockStatus, saleStatus, payMethod, role] = await Promise.all([
    prisma.stockStatus.upsert({ where: { name: 'Disponible' }, update: {}, create: { name: 'Disponible' } }),
    prisma.saleStatus.upsert({ where: { name: 'Completada' }, update: {}, create: { name: 'Completada' } }),
    prisma.paymentMethod.upsert({ where: { name: 'Efectivo' }, update: {}, create: { name: 'Efectivo' } }),
    prisma.role.upsert({ where: { name: 'Admin' }, update: {}, create: { name: 'Admin' } }),
  ])
  await prisma.status.upsert({ where: { name: 'Activa' }, update: {}, create: { name: 'Activa' } })
  await prisma.status.upsert({ where: { name: 'Resuelta' }, update: {}, create: { name: 'Resuelta' } })
  for (const n of ['Sin Stock', 'Stock Bajo', 'Vencimiento']) {
    await prisma.alertType.upsert({ where: { name: n }, update: {}, create: { name: n } })
  }
  for (const n of ['Crítica', 'Alta', 'Media', 'Baja']) {
    await prisma.alertPriority.upsert({ where: { name: n }, update: {}, create: { name: n } })
  }

  const { deductStockMap, restoreStockMap } = require('../src/services/bomStock')
  const { applyLocationDeltas, defaultLocationId, moveBetweenLocations } = require('../src/services/stockLocations')

  console.log('\n== 1. La sucursal nace con su almacén y ubicación por defecto ==')
  const co = await prisma.company.create({ data: { name: 'Bodegas SA', code: `BOD${Date.now() % 100000}` } })
  const suc = await prisma.branch.create({ data: { company_id: co.id, name: 'Central', code: 'CTR', is_default: true } })
  const user = await prisma.user.create({
    data: { name: 'Bodeguero', email: `b${Date.now()}@x.com`, password: 'h', role_id: role.id, default_branch_id: suc.id },
  })
  const cat = await prisma.productCategory.create({ data: { name: 'Licores', company_id: co.id } })
  const sup = await prisma.supplier.create({ data: { name: 'Prov', contact: 'c', company_id: co.id } })
  const ron = await prisma.product.create({
    data: {
      name: 'Ron', company_id: co.id, category_id: cat.id, supplier_id: sup.id,
      status_id: stockStatus.id, price: 100, cost: 60, stock: 0, min_stock: 2,
    },
  })

  // La sucursal se creó después de la migración: la ubicación se arma sola al primer uso.
  const generalId = await prisma.$transaction((tx) => defaultLocationId(tx, suc.id))
  const almacenes = await prisma.warehouse.findMany({ where: { branch_id: suc.id }, include: { locations: true } })
  assert(almacenes.length === 1 && almacenes[0].is_default, 'la sucursal tiene un almacén por defecto')
  assert(almacenes[0].locations.length === 1 && almacenes[0].locations[0].id === generalId,
    'y ese almacén tiene su ubicación por defecto')

  console.log('\n== 2. La mercancía entra a una ubicación real ==')
  await prisma.$transaction((tx) => restoreStockMap(tx, new Map([[ron.id, 10]]), suc.id, {
    reason: 'PURCHASE', refType: 'incoming_merchandise',
  }))
  assert((await stockByLocation(suc.id, ron.id)).GENERAL === 10, 'las 10 unidades quedaron en GENERAL')
  const entrada = await prisma.stockMovement.findFirst({ where: { product_id: ron.id }, orderBy: { created_at: 'desc' } })
  assert(entrada.qty === 10 && entrada.balance === 10 && entrada.reason === 'PURCHASE',
    'el libro anotó la entrada con su saldo y su motivo')

  console.log('\n== 3. Se despacha por prioridad y se pasa a la siguiente ubicación ==')
  const sala = await prisma.warehouse.create({
    data: { branch_id: suc.id, name: 'Sala de ventas', code: 'SALA', kind: 'SALA_VENTAS', dispatch_priority: 5 },
  })
  const salaLoc = await prisma.stockLocation.create({
    data: { warehouse_id: sala.id, code: 'SALA-01', dispatch_priority: 5 },
  })
  // Movimiento interno: cambia las ubicaciones, no el total de la sucursal.
  await prisma.$transaction((tx) => moveBetweenLocations(tx, {
    branchId: suc.id, fromLocationId: generalId, toLocationId: salaLoc.id,
    lines: [{ product_id: ron.id, qty: 4 }],
  }))
  const trasMover = await prisma.productStock.findUnique({
    where: { product_id_branch_id: { product_id: ron.id, branch_id: suc.id } },
  })
  assert(trasMover.stock === 10, 'mover entre ubicaciones no cambia el total de la sucursal')

  const antes = await prisma.stockMovement.count({ where: { product_id: ron.id } })
  await prisma.$transaction((tx) => deductStockMap(tx, new Map([[ron.id, 5]]), suc.id, {
    reason: 'SALE', refType: 'sale',
  }))
  const trasVenta = await stockByLocation(suc.id, ron.id)
  assert(trasVenta['SALA-01'] === 0 && trasVenta.GENERAL === 5,
    'la venta vació la ubicación prioritaria (4) y siguió con la otra (1)')
  const nuevos = await prisma.stockMovement.count({ where: { product_id: ron.id } })
  assert(nuevos - antes === 2, 'y dejó dos movimientos, uno por ubicación')

  console.log('\n== 4. Una ubicación que no despacha nunca sale ==')
  const cuarentena = await prisma.stockLocation.create({
    data: { warehouse_id: sala.id, code: 'CUAR', pickable: false, dispatch_priority: 1 },
  })
  await prisma.$transaction((tx) => moveBetweenLocations(tx, {
    branchId: suc.id, fromLocationId: generalId, toLocationId: cuarentena.id,
    lines: [{ product_id: ron.id, qty: 3 }],
  }))
  await prisma.$transaction((tx) => deductStockMap(tx, new Map([[ron.id, 2]]), suc.id, { reason: 'SALE' }))
  const trasCuarentena = await stockByLocation(suc.id, ron.id)
  assert(trasCuarentena.CUAR === 3, 'la cuarentena conservó sus 3 unidades')
  assert(trasCuarentena.GENERAL === 0, 'la salida vino de la ubicación que sí despacha')

  let bloqueado = null
  try {
    await prisma.$transaction((tx) => deductStockMap(tx, new Map([[ron.id, 1]]), suc.id, { reason: 'SALE' }))
  } catch (e) { bloqueado = e }
  assert(bloqueado?.code === 'LOCATION_STOCK_MISMATCH',
    'con todo el stock en cuarentena, la salida se rechaza en vez de inventar existencias')

  console.log('\n== 5. Los tres niveles siguen cuadrando ==')
  const [nivelEmpresa, nivelSucursal, nivelUbicacion] = await Promise.all([
    prisma.product.findUnique({ where: { id: ron.id }, select: { stock: true } }),
    prisma.productStock.findUnique({
      where: { product_id_branch_id: { product_id: ron.id, branch_id: suc.id } }, select: { stock: true },
    }),
    stockByLocation(suc.id, ron.id),
  ])
  const sumaUbicaciones = Object.values(nivelUbicacion).reduce((a, b) => a + b, 0)
  assert(nivelSucursal.stock === sumaUbicaciones, `sucursal (${nivelSucursal.stock}) == suma de ubicaciones`)
  assert(nivelEmpresa.stock === nivelSucursal.stock, 'empresa == suma de sucursales (aquí solo hay una)')

  console.log('\n== 6. El kardex cierra con las existencias ==')
  for (const [code, stock] of Object.entries(nivelUbicacion)) {
    const ultimo = await prisma.$queryRawUnsafe(`
      SELECT m.balance FROM stock_movements m
      JOIN stock_locations l ON l.id = m.location_id
      WHERE m.product_id = $1::uuid AND l.code = $2
      ORDER BY m.created_at DESC, m.id DESC LIMIT 1
    `, ron.id, code)
    if (!ultimo.length) continue
    assert(Number(ultimo[0].balance) === stock, `el último saldo de ${code} es su existencia (${stock})`)
  }

  console.log('\n== 7. Quitar de la sucursal exige 0 también en las ubicaciones ==')
  const productsCtl = require('../src/controllers/products.controller')
  // Estado que solo se alcanza forzándolo: los espejos dicen 0 pero la
  // cuarentena todavía guarda 3. La prueba defiende el invariante.
  await prisma.productStock.update({
    where: { product_id_branch_id: { product_id: ron.id, branch_id: suc.id } }, data: { stock: 0 },
  })
  await prisma.product.update({ where: { id: ron.id }, data: { stock: 0 } })
  const conStockOculto = await callController(productsCtl.removeFromBranch, {
    params: { id: ron.id }, companyId: co.id, branchId: suc.id,
  })
  assert(conStockOculto.status === 400, 'no se quita el producto si alguna ubicación aún tiene existencias')

  console.log('\n== 8. El ajuste manual también baja de las ubicaciones ==')
  const setBranchStockCtx = { params: { id: ron.id }, companyId: co.id, branchId: suc.id, user: { sub: user.id } }
  await prisma.$transaction(async (tx) => {
    const { applyBranchDelta } = require('../src/services/stockLocations')
    await applyBranchDelta(tx, [[ron.id, 3]], suc.id, -1, { reason: 'MANUAL_ADJUST', adjust: true })
  })
  const vacio = await stockByLocation(suc.id, ron.id)
  assert(Object.values(vacio).every((v) => v === 0), 'el ajuste a la baja dejó todas las ubicaciones en 0')
  const quitado = await callController(productsCtl.removeFromBranch, setBranchStockCtx)
  assert(quitado.body?.ok === true, 'ya en 0 en todos lados, el producto sale de la sucursal')
  const quedan = await stockByLocation(suc.id, ron.id)
  assert(Object.keys(quedan).length === 0, 'y sus filas de ubicación se fueron con él')

  console.log('\n== 9. CRUD de almacenes, siempre dentro de la sucursal ==')
  const warehouses = require('../src/controllers/warehouses.controller')
  const otraSuc = await prisma.branch.create({ data: { company_id: co.id, name: 'Anexo', code: 'ANX' } })

  const nuevo = await callController(warehouses.create, {
    body: { name: 'Vitrina', code: 'vit', kind: 'VITRINA', dispatch_priority: 1 },
    companyId: co.id, branchId: suc.id, user: { sub: user.id },
  })
  assert(nuevo.status === 201 && nuevo.body.code === 'VIT', 'el código del almacén se guarda en mayúsculas')
  assert(nuevo.body.is_default === false, 'no se roba el predeterminado, ya había uno')
  assert(nuevo.body.locations.length === 1, 'nace con su ubicación GENERAL: nunca hay un almacén sin dónde guardar')

  const repetido = await callController(warehouses.create, {
    body: { name: 'Otra vitrina', code: 'VIT' }, companyId: co.id, branchId: suc.id, user: { sub: user.id },
  })
  assert(repetido.status === 409, 'dos almacenes de la sucursal no comparten código')

  const enAnexo = await callController(warehouses.create, {
    body: { name: 'Vitrina', code: 'VIT' }, companyId: co.id, branchId: otraSuc.id, user: { sub: user.id },
  })
  assert(enAnexo.status === 201, 'pero otra sucursal sí puede reusar el mismo código')

  const desdeSuc = await callController(warehouses.list, { companyId: co.id, branchId: suc.id, user: { sub: user.id } })
  assert(!desdeSuc.body.some((w) => w.id === enAnexo.body.id), 'el almacén del Anexo no se ve desde Central')

  const ajeno = await callController(warehouses.update, {
    params: { id: enAnexo.body.id }, body: { name: 'Robada' },
    companyId: co.id, branchId: suc.id, user: { sub: user.id },
  })
  assert(ajeno.status === 404, 'y tampoco se puede editar desde otra sucursal')

  const principal = desdeSuc.body.find((w) => w.is_default)
  const borrarPrincipal = await callController(warehouses.remove, {
    params: { id: principal.id }, companyId: co.id, branchId: suc.id, user: { sub: user.id },
  })
  assert(borrarPrincipal.status === 400, 'el almacén predeterminado no se borra')

  const conHistorial = await callController(warehouses.remove, {
    params: { id: sala.id }, companyId: co.id, branchId: suc.id, user: { sub: user.id },
  })
  assert(conHistorial.status === 400, 'un almacén con movimientos se desactiva, no se borra')

  const limpio = await callController(warehouses.remove, {
    params: { id: nuevo.body.id }, companyId: co.id, branchId: suc.id, user: { sub: user.id },
  })
  assert(limpio.body?.ok === true, 'uno vacío y sin historial sí se borra')

  console.log('\n== 10. Movimientos internos y ajustes ==')
  const stockMoves = require('../src/controllers/stockMoves.controller')
  const vino = await prisma.product.create({
    data: {
      name: 'Vino', company_id: co.id, category_id: cat.id, supplier_id: sup.id,
      status_id: stockStatus.id, price: 80, cost: 40, stock: 0, min_stock: 1,
    },
  })
  await prisma.$transaction((tx) => restoreStockMap(tx, new Map([[vino.id, 10]]), suc.id, { reason: 'PURCHASE' }))

  const req10 = { companyId: co.id, branchId: suc.id, user: { sub: user.id } }
  const movido = await callController(stockMoves.createMove, {
    ...req10,
    body: { from_location_id: generalId, to_location_id: salaLoc.id, lines: [{ product_id: vino.id, qty: 4 }] },
  })
  assert(movido.status === 201 && movido.body.movements.length === 2,
    'el movimiento interno deja una salida y una entrada con el mismo grupo')
  const trasInterno = await stockByLocation(suc.id, vino.id)
  assert(trasInterno.GENERAL === 6 && trasInterno['SALA-01'] === 4, 'la mercancía cambió de ubicación')
  const totalSuc = await prisma.productStock.findUnique({
    where: { product_id_branch_id: { product_id: vino.id, branch_id: suc.id } },
  })
  assert(totalSuc.stock === 10, 'y el total de la sucursal no se movió')

  let sinExistencias = null
  try {
    await callController(stockMoves.createMove, {
      ...req10,
      body: { from_location_id: salaLoc.id, to_location_id: generalId, lines: [{ product_id: vino.id, qty: 99 }] },
    })
  } catch (e) { sinExistencias = e }
  assert(sinExistencias?.status === 400, 'no se puede mover más de lo que hay en el origen')

  let ajena = null
  try {
    await callController(stockMoves.createMove, {
      ...req10,
      body: {
        from_location_id: generalId, to_location_id: enAnexo.body.locations[0].id,
        lines: [{ product_id: vino.id, qty: 1 }],
      },
    })
  } catch (e) { ajena = e }
  assert(ajena?.status === 403, 'ni mover mercancía a una ubicación de otra sucursal')

  const ajuste = await callController(stockMoves.createAdjustment, {
    ...req10,
    body: { location_id: salaLoc.id, lines: [{ product_id: vino.id, qty: -3 }], notes: 'Botella quebrada' },
  })
  assert(ajuste.status === 201, 'el ajuste por merma se aplica')
  const trasAjuste = await stockByLocation(suc.id, vino.id)
  const [sucAjuste, empresaAjuste] = await Promise.all([
    prisma.productStock.findUnique({ where: { product_id_branch_id: { product_id: vino.id, branch_id: suc.id } } }),
    prisma.product.findUnique({ where: { id: vino.id }, select: { stock: true } }),
  ])
  assert(trasAjuste['SALA-01'] === 1, 'la merma salió de la ubicación indicada, no de otra')
  assert(sucAjuste.stock === 7 && empresaAjuste.stock === 7, 'y los tres niveles bajaron juntos (10 → 7)')

  const libro = await callController(stockMoves.list, { ...req10, query: { product_id: vino.id } })
  assert(libro.body[0].reason === 'MANUAL_ADJUST' && libro.body[0].notes === 'Botella quebrada',
    'el libro conserva el motivo y la nota del ajuste')

  console.log('\n== 11. El punto de venta despacha de su ubicación, no de la que más tenga ==')
  // Hoy SALA-01 tiene prioridad sobre GENERAL: si la venta sale de GENERAL es
  // porque mandó la ubicación del punto de venta y no la prioridad.
  const marcada = await callController(warehouses.setSalesLocation, { ...req10, params: { locationId: generalId } })
  assert(marcada.body.sales_location_id === generalId, 'la sucursal quedó vendiendo desde GENERAL')

  await prisma.$transaction((tx) => deductStockMap(tx, new Map([[vino.id, 2]]), suc.id, { reason: 'SALE' }))
  const trasPos = await stockByLocation(suc.id, vino.id)
  assert(trasPos.GENERAL === 4 && trasPos['SALA-01'] === 1,
    'la venta salió del mostrador (6 → 4) y no tocó la ubicación prioritaria')

  await prisma.$transaction((tx) => restoreStockMap(tx, new Map([[vino.id, 1]]), suc.id, { reason: 'SALE_RETURN' }))
  assert((await stockByLocation(suc.id, vino.id)).GENERAL === 5, 'y la devolución vuelve al mismo mostrador')

  // Si al mostrador no le alcanza, la venta sigue en vez de trabarse.
  await prisma.$transaction((tx) => deductStockMap(tx, new Map([[vino.id, 6]]), suc.id, { reason: 'SALE' }))
  const conDesborde = await stockByLocation(suc.id, vino.id)
  assert(conDesborde.GENERAL === 0 && conDesborde['SALA-01'] === 0,
    'agotado el mostrador, el resto salió de las demás ubicaciones')

  const listado = await callController(warehouses.list, req10)
  const generalRow = listado.body.flatMap((w) => w.locations).find((l) => l.id === generalId)
  assert(generalRow.is_sales === true, 'el listado dice cuál ubicación es la del punto de venta')

  const desmarcada = await callController(warehouses.setSalesLocation, { ...req10, params: { locationId: generalId } })
  assert(desmarcada.body.sales_location_id === null, 'volver a marcarla deja la sucursal sin ubicación de venta fija')

  console.log('\n== 12. El conteo físico se hace y se aplica ubicación por ubicación ==')
  const counts = require('../src/controllers/inventoryCounts.controller')
  // Whisky solo en dos ubicaciones de la sucursal: 6 en GENERAL y 2 en SALA-01.
  const whisky = await prisma.product.create({
    data: {
      name: 'Whisky', company_id: co.id, category_id: cat.id, supplier_id: sup.id,
      status_id: stockStatus.id, price: 200, cost: 120, stock: 0, min_stock: 1,
    },
  })
  await prisma.$transaction((tx) => restoreStockMap(tx, new Map([[whisky.id, 8]]), suc.id, { reason: 'PURCHASE' }))
  await callController(stockMoves.createMove, {
    ...req10,
    body: { from_location_id: generalId, to_location_id: salaLoc.id, lines: [{ product_id: whisky.id, qty: 2 }] },
  })

  const sesion = await callController(counts.create, {
    ...req10, body: { name: 'Conteo por ubicación', scope: { categoryIds: [cat.id] } },
  })
  assert(sesion.status === 201, 'la sesión de conteo se crea')
  const iniciada = await callController(counts.start, { ...req10, params: { id: sesion.body.id } })
  assert(iniciada.status === 200, 'y se inicia generando sus líneas')

  const lineas = await callController(counts.listLines, {
    ...req10, params: { id: sesion.body.id }, query: { limit: 200 },
  })
  const delWhisky = lineas.body.data.filter((L) => L.product.id === whisky.id)
  assert(delWhisky.length === 2, 'el whisky se cuenta dos veces: una por ubicación donde está')
  const enGeneral = delWhisky.find((L) => L.location.id === generalId)
  const enSala = delWhisky.find((L) => L.location.id === salaLoc.id)
  assert(enGeneral.stock_snapshot === 6 && enSala.stock_snapshot === 2,
    'y cada línea trae la existencia de SU ubicación (6 y 2)')

  const porUbicacion = await callController(counts.listLines, {
    ...req10, params: { id: sesion.body.id }, query: { location_id: salaLoc.id, limit: 200 },
  })
  assert(porUbicacion.body.data.every((L) => L.location.id === salaLoc.id),
    'el listado se puede acotar a la ubicación que se está contando')

  // Faltan 2 en la bodega y aparecen 2 en la sala: la sucursal no cambia.
  // El resto de líneas se cuentan tal cual, que enviar exige contarlas todas.
  for (const L of lineas.body.data) {
    const qty = L.product.id === whisky.id ? 4 : L.stock_snapshot
    await callController(counts.updateLine, {
      ...req10, params: { id: sesion.body.id, lineId: L.id }, body: { qty_counted: qty },
    })
  }
  await callController(counts.submit, {
    ...req10, params: { id: sesion.body.id }, body: { reason: 'Conteo mensual' },
  })
  const aprobado = await callController(counts.approve, {
    ...req10, params: { id: sesion.body.id }, body: { reason: 'Revisado y correcto' },
  })
  assert(aprobado.status === 200, 'el conteo se aprueba y se aplica')

  const trasConteo = await stockByLocation(suc.id, whisky.id)
  assert(trasConteo.GENERAL === 4 && trasConteo['SALA-01'] === 4,
    'cada ubicación quedó con lo que se contó ahí (4 y 4)')
  const [sucConteo, empresaConteo] = await Promise.all([
    prisma.productStock.findUnique({ where: { product_id_branch_id: { product_id: whisky.id, branch_id: suc.id } } }),
    prisma.product.findUnique({ where: { id: whisky.id }, select: { stock: true } }),
  ])
  assert(sucConteo.stock === 8 && empresaConteo.stock === 8,
    'lo que faltó en un anaquel y sobró en otro dejó el total de la sucursal igual (8)')

  const kardex = await callController(stockMoves.list, { ...req10, query: { product_id: whisky.id, reason: 'COUNT_ADJUST' } })
  assert(kardex.body.length === 2, 'y el libro anotó el ajuste en las dos ubicaciones')

  console.log('\n== 13. El traslado sale por ubicación, entra donde se indique y vuelve a su origen ==')
  const transfers = require('../src/controllers/transfers.controller')
  const tequila = await prisma.product.create({
    data: {
      name: 'Tequila', company_id: co.id, category_id: cat.id, supplier_id: sup.id,
      status_id: stockStatus.id, price: 150, cost: 90, stock: 0, min_stock: 1,
    },
  })
  await prisma.$transaction((tx) => restoreStockMap(tx, new Map([[tequila.id, 8]]), suc.id, { reason: 'PURCHASE' }))
  await callController(stockMoves.createMove, {
    ...req10,
    body: { from_location_id: generalId, to_location_id: salaLoc.id, lines: [{ product_id: tequila.id, qty: 3 }] },
  })

  const recepcion = await prisma.stockLocation.create({
    data: { warehouse_id: enAnexo.body.id, code: 'RECEP', name: 'Recepción' },
  })
  const enviado = await callController(transfers.create, {
    ...req10, body: { to_branch_id: otraSuc.id, items: [{ product_id: tequila.id, qty: 6 }] },
  })
  assert(enviado.status === 201, 'el traslado sale de Central')
  const trasEnvio = await stockByLocation(suc.id, tequila.id)
  assert(trasEnvio['SALA-01'] === 0 && trasEnvio.GENERAL === 2,
    'salió primero del anaquel prioritario (3) y el resto de la bodega (3)')

  const req13 = { companyId: co.id, branchId: otraSuc.id, user: { sub: user.id } }
  const recibido = await callController(transfers.receive, {
    ...req13, params: { id: enviado.body.id }, body: { to_location_id: recepcion.id },
  })
  assert(recibido.status === 200, 'el Anexo lo recibe')
  assert((await stockByLocation(otraSuc.id, tequila.id)).RECEP === 6,
    'y entró en la ubicación indicada, no en la de recepción por defecto')

  // Lo que queda en Central se sube al anaquel: así, al cancelar, volver "a la
  // ubicación por defecto" y volver "al origen" dan respuestas distintas.
  await callController(stockMoves.createMove, {
    ...req10,
    body: { from_location_id: generalId, to_location_id: salaLoc.id, lines: [{ product_id: tequila.id, qty: 2 }] },
  })
  const segundo = await callController(transfers.create, {
    ...req10, body: { to_branch_id: otraSuc.id, items: [{ product_id: tequila.id, qty: 2 }] },
  })
  assert(segundo.status === 201, 'sale un segundo traslado, esta vez desde el anaquel')

  let ubicacionAjena = null
  try {
    await callController(transfers.receive, {
      ...req13, params: { id: segundo.body.id }, body: { to_location_id: salaLoc.id },
    })
  } catch (e) { ubicacionAjena = e }
  assert(ubicacionAjena?.status === 403, 'no se puede recibir en una ubicación de otra sucursal')

  const cancelado = await callController(transfers.cancel, { ...req10, params: { id: segundo.body.id } })
  assert(cancelado.status === 200, 'el traslado se cancela')
  const trasCancelar = await stockByLocation(suc.id, tequila.id)
  assert(trasCancelar['SALA-01'] === 2 && trasCancelar.GENERAL === 0,
    'y las unidades volvieron al anaquel del que salieron, no a la ubicación por defecto')

  console.log('\n== 14. Los lotes viven en una ubicación: primero el anaquel, después la caducidad ==')
  const dias = (n) => new Date(Date.now() + n * 86400000)
  const cerveza = await prisma.product.create({
    data: {
      name: 'Cerveza', company_id: co.id, category_id: cat.id, supplier_id: sup.id,
      status_id: stockStatus.id, price: 20, cost: 10, stock: 0, min_stock: 1, tracks_expiry: true,
    },
  })
  await prisma.$transaction(async (tx) => {
    await restoreStockMap(tx, new Map([[cerveza.id, 9]]), suc.id, {
      reason: 'PURCHASE', lotsManagedExternally: true,
    })
    await applyLocationDeltas(tx, [
      { product_id: cerveza.id, location_id: generalId, qty: -5 },
      { product_id: cerveza.id, location_id: salaLoc.id, qty: 5 },
    ], { branchId: suc.id, reason: 'INTERNAL_MOVE' })
    await tx.productLot.createMany({
      data: [
        { product_id: cerveza.id, branch_id: suc.id, location_id: generalId, lot_code: 'VIEJO', expiry_date: dias(5), qty_received: 4, qty_remaining: 4 },
        { product_id: cerveza.id, branch_id: suc.id, location_id: salaLoc.id, lot_code: 'MEDIO', expiry_date: dias(10), qty_received: 2, qty_remaining: 2 },
        { product_id: cerveza.id, branch_id: suc.id, location_id: salaLoc.id, lot_code: 'NUEVO', expiry_date: dias(60), qty_received: 3, qty_remaining: 3 },
      ],
    })
  })

  const lotesDe = async () => Object.fromEntries(
    (await prisma.productLot.findMany({ where: { product_id: cerveza.id }, select: { lot_code: true, qty_remaining: true, location_id: true } }))
      .map((l) => [`${l.lot_code}@${l.location_id === salaLoc.id ? 'SALA-01' : 'GENERAL'}`, l.qty_remaining])
  )

  await prisma.$transaction((tx) => deductStockMap(tx, new Map([[cerveza.id, 2]]), suc.id, {
    reason: 'SALE', refType: 'sale', refId: require('crypto').randomUUID(),
    groupId: require('crypto').randomUUID(),
  }))
  const trasVender = await lotesDe()
  assert(trasVender['VIEJO@GENERAL'] === 4,
    'el lote más próximo a vencer no se tocó: está en otro anaquel')
  assert(trasVender['MEDIO@SALA-01'] === 0 && trasVender['NUEVO@SALA-01'] === 3,
    'dentro del anaquel que despachó sí manda la caducidad (se fue MEDIO, no NUEVO)')

  await callController(stockMoves.createMove, {
    ...req10,
    body: { from_location_id: salaLoc.id, to_location_id: generalId, lines: [{ product_id: cerveza.id, qty: 2 }] },
  })
  const trasMudanza = await lotesDe()
  assert(trasMudanza['NUEVO@SALA-01'] === 1 && trasMudanza['NUEVO@GENERAL'] === 2,
    'y al mover mercancía entre anaqueles el lote se muda con ella')

  console.log('\n== 15. Reposición interna: falta en el anaquel, no en la sucursal ==')
  // Cerveza quedó con 6 en GENERAL y 1 en SALA-01.
  const conMinimo = await callController(stockMoves.setLocationMin, {
    ...req10, body: { product_id: cerveza.id, location_id: salaLoc.id, min_stock: 5 },
  })
  assert(conMinimo.body.min_stock === 5, 'el anaquel guarda su mínimo interno')

  const minAjeno = await callController(stockMoves.setLocationMin, {
    ...req10,
    body: { product_id: cerveza.id, location_id: enAnexo.body.locations[0].id, min_stock: 5 },
  })
  assert(minAjeno.status === 403, 'y no se le pone mínimo a una ubicación de otra sucursal')

  const sugerencias = await callController(stockMoves.replenishment, { ...req10, query: {} })
  const deCerveza = sugerencias.body.find((r) => r.product_id === cerveza.id)
  assert(deCerveza && deCerveza.location_id === salaLoc.id && deCerveza.missing === 4,
    'la sugerencia dice que al anaquel le faltan 4')
  assert(deCerveza.from_location_id === generalId && deCerveza.suggested_qty === 4,
    'y de dónde traerlas: de la bodega, que tiene 6')

  const sucCerveza = await prisma.productStock.findUnique({
    where: { product_id_branch_id: { product_id: cerveza.id, branch_id: suc.id } },
  })
  assert(sucCerveza.stock === 7, 'la sucursal no tiene faltante: solo está mal repartido (7 en total)')

  console.log('\n== 16. Códigos automáticos, alta en sucursal, baja de lotes e ingreso dirigido ==')
  const branchesCtl = require('../src/controllers/branches.controller')

  const autoAlm = await callController(warehouses.create, { ...req10, body: { name: 'Sala de ventas' } })
  assert(autoAlm.status === 201 && autoAlm.body.code === 'SALADEVENTAS',
    'el almacén saca su código del nombre, sin pedírselo a nadie')
  const autoAlm2 = await callController(warehouses.create, { ...req10, body: { name: 'Sala de ventas' } })
  assert(autoAlm2.body.code === 'SALADEVENTAS2', 'y el segundo con el mismo nombre no choca')

  const autoUbi = await callController(warehouses.createLocation, {
    ...req10, params: { id: autoAlm.body.id }, body: { name: 'Anaquel 3' },
  })
  assert(autoUbi.status === 201 && autoUbi.body.code === 'ANAQUEL3', 'la ubicación también se codifica sola')

  const autoSuc = await callController(branchesCtl.create, {
    companyId: co.id, user: { sub: user.id }, body: { name: 'Bodega Norte' },
  })
  assert(autoSuc.status === 201 && autoSuc.body.code === 'BODEGANORT',
    'y la sucursal igual, recortada a los 10 caracteres que caben')

  // Producto del catálogo que esta sucursal no maneja: se empieza a manejar sin inventar stock.
  const importado = await prisma.product.create({
    data: {
      name: 'Importado', company_id: co.id, category_id: cat.id, supplier_id: sup.id,
      status_id: stockStatus.id, price: 300, cost: 200, stock: 0, min_stock: 0,
    },
  })
  const alta = await callController(productsCtl.addToBranch, { ...req10, params: { id: importado.id }, body: {} })
  assert(alta.status === 201 && alta.body.branch_stock.stock === 0,
    'el producto empieza a manejarse en la sucursal, con existencia 0')
  const repetida = await callController(productsCtl.addToBranch, { ...req10, params: { id: importado.id }, body: {} })
  assert(repetida.body.already === true, 'y volver a darlo de alta no duplica ni truena')

  // Baja de lote vencido: sale del anaquel donde estaba, no de otro.
  const viejo = await prisma.productLot.findFirst({ where: { product_id: cerveza.id, lot_code: 'VIEJO' } })
  const antesBaja = await stockByLocation(suc.id, cerveza.id)
  const baja = await callController(productsCtl.writeOffLots, {
    ...req10, body: { lot_ids: [viejo.id], reason: 'Vencido en bodega' },
  })
  assert(baja.body.units === viejo.qty_remaining, `la baja saca las ${viejo.qty_remaining} unidades que quedaban`)
  const trasBaja = await stockByLocation(suc.id, cerveza.id)
  assert(trasBaja.GENERAL === antesBaja.GENERAL - viejo.qty_remaining && trasBaja['SALA-01'] === antesBaja['SALA-01'],
    'y las saca de la ubicación del lote, sin tocar las otras')
  const lotEnCero = await prisma.productLot.findUnique({ where: { id: viejo.id } })
  assert(lotEnCero.qty_remaining === 0, 'el lote queda en 0 pero no se borra: el rastro importa')
  const movBaja = await prisma.stockMovement.findFirst({
    where: { ref_type: 'product_lot', ref_id: viejo.id }, orderBy: { created_at: 'desc' },
  })
  assert(movBaja.notes.includes('Vencido en bodega'), 'el libro dice por qué se dio de baja')

  // Ingreso dirigido a una ubicación concreta.
  const destino = autoUbi.body.id
  const ingreso = await callController(productsCtl.registerIncomingMerchandise, {
    ...req10,
    body: {
      supplier_id: sup.id, location_id: destino,
      items: [{ product_id: importado.id, quantity: 5, unit_cost: 200, expiry_date: dias(90).toISOString().slice(0, 10) }],
    },
  })
  assert(ingreso.status === 201 || ingreso.status === 200, 'la mercancía se registra')
  const trasIngreso = await stockByLocation(suc.id, importado.id)
  assert(trasIngreso.ANAQUEL3 === 5, 'y entró en la ubicación elegida, no en la de recepción por defecto')
  const loteNuevo = await prisma.productLot.findFirst({ where: { product_id: importado.id } })
  assert(loteNuevo.location_id === destino, 'el lote se guarda donde quedó la mercancía')

  console.log('\n== 17. El inventario se acota por sucursal, almacén y ubicación ==')
  // Cerveza quedó repartida: GENERAL y SALA-01 de Central.
  const req17 = { ...req10, userBranchIds: [suc.id, otraSuc.id] }
  const porUbicacionStock = await stockByLocation(suc.id, cerveza.id)

  const todaLaEmpresa = await callController(productsCtl.list, {
    ...req17, branchId: null, branchIds: [suc.id, otraSuc.id], query: { branch_id: 'all', pageSize: 100 },
  })
  const cervezaEmpresa = todaLaEmpresa.body.items.find((p) => p.id === cerveza.id)
  const cervezaReal = await prisma.product.findUnique({ where: { id: cerveza.id }, select: { stock: true } })
  assert(cervezaEmpresa.stock === cervezaReal.stock,
    'sin sucursal, el listado trae el total de la empresa')

  const soloCentral = await callController(productsCtl.list, {
    ...req17, query: { branch_id: suc.id, pageSize: 100 },
  })
  const cervezaCentral = soloCentral.body.items.find((p) => p.id === cerveza.id)
  const enSucursal = await prisma.productStock.findUnique({
    where: { product_id_branch_id: { product_id: cerveza.id, branch_id: suc.id } },
  })
  assert(cervezaCentral.stock === enSucursal.stock, 'con sucursal, el de esa sucursal')

  const salaWarehouse = await prisma.warehouse.findFirst({ where: { branch_id: suc.id, code: 'SALA' } })
  const soloSala = await callController(productsCtl.list, {
    ...req17, query: { branch_id: suc.id, warehouse_id: salaWarehouse.id, pageSize: 100 },
  })
  const cervezaSala = soloSala.body.items.find((p) => p.id === cerveza.id)
  assert(cervezaSala.stock === porUbicacionStock['SALA-01'],
    'acotado al almacén, solo cuenta lo que está ahí')
  assert(soloSala.body.items.every((p) => p.stock !== 0),
    'y no lista productos que no están en ese almacén')

  const soloGeneral = await callController(productsCtl.list, {
    ...req17, query: { location_id: generalId, pageSize: 100 },
  })
  const cervezaGeneral = soloGeneral.body.items.find((p) => p.id === cerveza.id)
  assert(cervezaGeneral.stock === porUbicacionStock.GENERAL, 'y acotado al anaquel, lo del anaquel')

  let sucursalAjena = null
  try {
    await callController(productsCtl.list, {
      ...req10, userBranchIds: [suc.id], query: { branch_id: otraSuc.id },
    })
  } catch (e) { sucursalAjena = e }
  assert(sucursalAjena?.status === 403, 'no se puede espiar el inventario de una sucursal ajena')

  console.log('\nTODAS LAS PRUEBAS PASARON')
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
