/**
 * Los cuatro últimos hallazgos de la auditoría, juntos porque comparten montaje:
 *
 *   7  una venta de un turno de caja cerrado ya no se puede cambiar de estado
 *   8  el límite de usos de un código de promoción no se pasa por uno
 *   9  la contabilización procesa por tandas y sin traerse todo a memoria
 *   10 dos envíos con la misma clave de intento dan una sola venta
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
  Promise.resolve(fn(req, res, (e) => reject(e))).catch(reject)
})

const CUENTAS = [
  ['cash', '1101', 'Caja', 'ASSET'], ['bank', '1102', 'Bancos', 'ASSET'],
  ['receivables', '1103', 'Clientes', 'ASSET'], ['ivaCredit', '1104', 'IVA crédito', 'ASSET'],
  ['inventory', '1105', 'Inventario', 'ASSET'], ['payables', '2101', 'Proveedores', 'LIABILITY'],
  ['ivaDebit', '2102', 'IVA débito', 'LIABILITY'], ['pequenoTax', '2103', 'Impuesto pequeño', 'LIABILITY'],
  ['retainedEarnings', '3201', 'Utilidades acumuladas', 'EQUITY'],
  ['currentEarnings', '3202', 'Utilidad del ejercicio', 'EQUITY'],
  ['sales', '4101', 'Ventas', 'INCOME'], ['salesReturns', '4102', 'Devoluciones', 'INCOME'],
  ['cogs', '5101', 'Costo de ventas', 'COST'], ['pequenoTaxExpense', '6105', 'Impuesto pequeño gasto', 'EXPENSE'],
]

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
  for (const n of ['Activa', 'Resuelta']) {
    await prisma.status.upsert({ where: { name: n }, update: {}, create: { name: n } })
  }

  const { restoreStockMap } = require('../src/services/bomStock')
  const { postPendingOperations } = require('../src/services/accounting/postingEngine')
  const sales = require('../src/modules/sales/controller')

  const co = await prisma.company.create({ data: { name: 'Blindaje SA', code: `BL${Date.now() % 100000}` } })
  const suc = await prisma.branch.create({ data: { company_id: co.id, name: 'Central', code: 'CTR', is_default: true } })
  const caja = await prisma.cashRegister.create({
    data: { branch_id: suc.id, name: 'Caja 1', code: 'C1', is_default: true },
  })
  const user = await prisma.user.create({
    data: { name: 'Admin', email: `h${Date.now()}@x.com`, password: 'h', role_id: role.id, default_branch_id: suc.id },
  })
  const cat = await prisma.productCategory.create({ data: { name: 'Licores', company_id: co.id } })
  const sup = await prisma.supplier.create({ data: { name: 'Prov', contact: 'c', company_id: co.id } })
  const ron = await prisma.product.create({
    data: {
      name: 'Ron', company_id: co.id, category_id: cat.id, supplier_id: sup.id,
      status_id: stockStatus.id, price: 100, cost: 40, stock: 0, min_stock: 0,
    },
  })
  await prisma.$transaction((tx) => restoreStockMap(tx, new Map([[ron.id, 200]]), suc.id, { reason: 'PURCHASE' }))

  const req = (body, extra = {}) => ({
    body, companyId: co.id, branchId: suc.id, query: {},
    user: { sub: user.id, role: { name: 'Admin' } },
    get: () => undefined,
    ...extra,
  })
  const vender = (extra = {}) => callController(sales.create, req({
    items: [{ product_id: ron.id, qty: 1, price: 100 }],
    customer: 'Cliente', is_final_consumer: true,
    payment_method_id: payMethod.id, amount_received: 100, change: 0,
    ...extra,
  }))

  console.log('\n== 10. Idempotencia: dos envíos con la misma clave ==')
  const clave = `intento-${Date.now()}`
  const primera = await vender({ idempotency_key: clave })
  assert(primera.status === 201, `la primera venta entra (${primera.status})`)
  const segunda = await vender({ idempotency_key: clave })
  assert(segunda.status === 200, `la segunda responde 200, no 201 (${segunda.status})`)
  assert(segunda.body.id === primera.body.id, 'y devuelve la misma venta, no una nueva')
  const cuantas = await prisma.sale.count({ where: { branch_id: suc.id, idempotency_key: clave } })
  assert(cuantas === 1, `una sola venta guardada — hay ${cuantas}`)

  const tercera = await vender({ idempotency_key: `otro-${Date.now()}` })
  assert(tercera.status === 201 && tercera.body.id !== primera.body.id,
    'con otra clave sí se registra una venta distinta')

  const sinClave = await vender()
  assert(sinClave.status === 201, 'y sin clave todo sigue como antes')

  console.log('\n== 8. El límite de usos de una promoción no se pasa por uno ==')
  const tipo = await prisma.promotionType.upsert({
    where: { name: 'PERCENTAGE' }, update: {}, create: { name: 'PERCENTAGE' },
  })
  const promo = await prisma.promotion.create({
    data: {
      company_id: co.id, name: 'Diez por ciento', type_id: tipo.id,
      discount_percentage: 10, max_uses: 1, active: true, applies_to_all: true,
    },
  })
  const codigo = await prisma.promotionCode.create({
    data: { company_id: co.id, promotion_id: promo.id, code: `PRUEBA${Date.now() % 100000}` },
  })
  const conCodigo = () => callController(sales.create, req({
    items: [{ product_id: ron.id, qty: 1, price: 100 }],
    customer: 'Cliente', is_final_consumer: true,
    payment_method_id: payMethod.id, amount_received: 100, change: 0,
    promotion_codes: [codigo.code],
  }))
  const uso1 = await conCodigo()
  assert(uso1.status === 201, `el primer uso pasa (${uso1.status}) ${JSON.stringify(uso1.body).slice(0, 150)}`)
  let uso2 = null
  try { uso2 = await conCodigo() } catch (e) { uso2 = { error: e } }
  assert(uso2?.error || uso2.status >= 400, 'el segundo uso se rechaza')
  const contador = await prisma.promotionCode.findUnique({ where: { id: codigo.id } })
  assert(contador.current_uses === 1, `el contador queda en 1, no en 2 — quedó en ${contador.current_uses}`)

  // Lo anterior lo atajaba también la validación vieja (leer y comparar). El
  // caso que sí se escapaba es el simultáneo: dos ventas leen 0, ambas creen
  // tener el último uso disponible. Acá el que decide es el incremento
  // condicional, que bloquea la fila y reevalúa.
  await prisma.promotionCode.update({ where: { id: codigo.id }, data: { current_uses: 0 } })
  const aLaVez = await Promise.allSettled([conCodigo(), conCodigo()])
  const pasaron = aLaVez.filter(
    (r) => r.status === 'fulfilled' && r.value?.status === 201
  ).length
  assert(pasaron === 1, `de dos ventas simultáneas con el último uso, pasa una sola — pasaron ${pasaron}`)
  const trasCarrera = await prisma.promotionCode.findUnique({ where: { id: codigo.id } })
  assert(trasCarrera.current_uses === 1,
    `y el contador no se pasa de 1 — quedó en ${trasCarrera.current_uses}`)

  console.log('\n== 7. Una venta de un turno cerrado no se cambia de estado ==')
  const turno = await prisma.cashRegisterSession.create({
    data: { cash_register_id: caja.id, opened_by_id: user.id, opening_float: 0, status: 'OPEN' },
  })
  const enTurno = await vender()
  assert(enTurno.status === 201, 'la venta del turno abierto entra')
  const ventaDelTurno = await prisma.sale.findUnique({ where: { id: enTurno.body.id } })
  assert(ventaDelTurno.cash_register_session_id === turno.id, 'y queda atada al turno abierto')

  const cancelada = await prisma.saleStatus.findUnique({ where: { name: 'Cancelada' } })
  await prisma.cashRegisterSession.update({
    where: { id: turno.id }, data: { status: 'CLOSED', closed_at: new Date(), closed_by_id: user.id },
  })

  let bloqueada = null
  try {
    await callController(sales.updateStatus, {
      params: { id: enTurno.body.id }, body: { status_id: cancelada.id },
      companyId: co.id, branchId: suc.id, user: { sub: user.id }, query: {},
    })
  } catch (e) { bloqueada = e }
  assert(bloqueada?.code === 'CASH_SESSION_CLOSED',
    `cerrado el turno, cancelar se rechaza — salió ${bloqueada?.code || 'nada'}`)
  const intacta = await prisma.sale.findUnique({ where: { id: enTurno.body.id }, include: { status: true } })
  assert(intacta.status.name === 'Completada', 'y la venta se queda como estaba')

  console.log('\n== 9. La contabilización procesa lo pendiente y no lo ya hecho ==')
  const codigos = {}
  for (const [key, code, name, type] of CUENTAS) {
    await prisma.account.create({ data: { company_id: co.id, code, name, type } })
    codigos[key] = code
  }
  await prisma.systemSetting.create({
    data: { company_id: co.id, key: 'accounting.defaultAccounts', value: JSON.stringify(codigos) },
  })
  await prisma.systemSetting.create({
    data: { company_id: co.id, key: 'vat_affiliation', value: 'PEQUENO' },
  })

  const completadas = await prisma.sale.count({
    where: { branch_id: suc.id, status: { name: 'Completada' } },
  })
  const primeraCorrida = await postPendingOperations(prisma, user.id, co.id)
  assert(primeraCorrida.posted === completadas,
    `contabiliza las ${completadas} ventas completadas — contabilizó ${primeraCorrida.posted}`)
  assert(primeraCorrida.hasMore === false, 'y avisa que no quedó nada pendiente')

  const segundaCorrida = await postPendingOperations(prisma, user.id, co.id)
  assert(segundaCorrida.posted === 0, `la segunda corrida no repite nada — repitió ${segundaCorrida.posted}`)
  const asientos = await prisma.journalEntry.count({ where: { company_id: co.id, source_type: 'SALE' } })
  assert(asientos === completadas, `un asiento por venta y no más — hay ${asientos}`)

  console.log('\nTODAS LAS PRUEBAS PASARON')
}

main().catch((e) => { console.error(e); process.exitCode = 1 }).finally(() => prisma.$disconnect())
