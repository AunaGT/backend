/**
 * Cuentas por cobrar: venta al crédito, aplicación FIFO de cobros y su posteo.
 *
 * Antes de esto el crédito estaba a medias: `cashOrBank` ya mandaba la venta a
 * la cuenta de Clientes, pero nada la acreditaba nunca (la cuenta solo crecía) y
 * no había forma de saber qué cliente debía cuánto. Ver src/services/receivables.js
 * y la sección "Cobros de clientes" de postPendingOperations.
 *
 * Cubre: (a) el FIFO aplica a la factura más vieja primero; (b) los estados
 * PENDING/PARTIAL/PAID salen de los abonos; (c) el sobrepago se rechaza;
 * (d) una devolución parcial baja la deuda sin tocar abonos; (e) borrar un cobro
 * restaura los estados y cascadea sus aplicaciones; (f) el límite de crédito
 * bloquea por vencidas y por monto; (g) el asiento del cobro cuadra, cierra el
 * saldo de Clientes y no se duplica al reintentar; (h) aislamiento por sucursal.
 *
 * Uso: contra un Postgres desechable ya migrado (incluye 20260827100000_receivables
 * y 20260827100001_sale_payment_journal_source_type).
 *   DATABASE_URL=postgresql://... node tests/receivables.e2e.js
 */
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

const assert = (cond, msg) => {
  if (!cond) { console.error('FALLO:', msg); process.exitCode = 1; throw new Error(msg) }
  console.log('  ok:', msg)
}

const CUENTAS = [
  ['cash', '1101', 'Caja', 'ASSET'], ['bank', '1102', 'Bancos', 'ASSET'],
  ['receivables', '1103', 'Clientes', 'ASSET'], ['ivaCredit', '1104', 'IVA credito', 'ASSET'],
  ['inventory', '1105', 'Inventario', 'ASSET'], ['payables', '2101', 'Proveedores', 'LIABILITY'],
  ['ivaDebit', '2102', 'IVA debito', 'LIABILITY'], ['pequenoTax', '2103', 'Impuesto pequeno', 'LIABILITY'],
  ['retainedEarnings', '3201', 'Utilidades acumuladas', 'EQUITY'],
  ['currentEarnings', '3202', 'Utilidad del ejercicio', 'EQUITY'],
  ['sales', '4101', 'Ventas', 'INCOME'], ['salesReturns', '4102', 'Devoluciones', 'INCOME'],
  ['cogs', '5101', 'Costo de ventas', 'COST'], ['pequenoTaxExpense', '6105', 'Impuesto pequeno gasto', 'EXPENSE'],
]

const dias = (n) => new Date(Date.now() + n * 86400000)

async function main() {
  const R = require('../src/services/receivables')
  const { postPendingOperations } = require('../src/services/accounting/postingEngine')

  // ---- Datos base ----
  const co = await prisma.company.create({ data: { name: 'Cartera SA', code: `CX${Date.now() % 100000}` } })
  const suc = await prisma.branch.create({
    data: { company_id: co.id, name: 'Central', code: 'CTR', is_default: true },
  })
  const rol = await prisma.role.create({ data: { name: `rol-${Date.now()}` } })
  const usuario = await prisma.user.create({
    data: { name: 'Cajero', email: `cx-${Date.now()}@t.com`, password: 'x', role_id: rol.id },
  })
  const completada =
    (await prisma.saleStatus.findFirst({ where: { name: 'Completada' } })) ||
    (await prisma.saleStatus.create({ data: { name: 'Completada' } }))
  const efectivo =
    (await prisma.paymentMethod.findFirst({ where: { name: 'Efectivo' } })) ||
    (await prisma.paymentMethod.create({ data: { name: 'Efectivo', is_credit: false } }))
  const credito =
    (await prisma.paymentMethod.findFirst({ where: { is_credit: true } })) ||
    (await prisma.paymentMethod.create({ data: { name: 'Crédito', is_credit: true } }))

  const cliente = await prisma.supplier.create({
    data: {
      company_id: co.id, party_type: 'CUSTOMER', name: 'Abarrotería La Bendición',
      contact: 'Doña Mari', credit_limit: '10000.00',
    },
  })

  const branchWhere = { branch_id: suc.id }
  const ventaCredito = (total, venceEnDias, ref) => prisma.sale.create({
    data: {
      branch_id: suc.id, reference: ref, customer_contact_id: cliente.id,
      total: String(total), adjusted_total: String(total), total_returned: '0', items: 1,
      payment_method_id: credito.id, status_id: completada.id, created_by: usuario.id,
      payment_status: 'PENDING', due_date: dias(venceEnDias), date: dias(venceEnDias - 30),
    },
  })

  // ---- (a) orden FIFO ----
  const v1 = await ventaCredito(100, -40, 'V-1')  // vencida hace 40 días
  const v2 = await ventaCredito(200, -10, 'V-2')  // vencida hace 10 días
  const v3 = await ventaCredito(50, 20, 'V-3')    // aún corriente

  const abiertas = await R.openSalesOf(prisma, cliente.id, branchWhere)
  assert(
    JSON.stringify(abiertas.map((s) => s.reference)) === JSON.stringify(['V-1', 'V-2', 'V-3']),
    'las facturas abiertas salen ordenadas por vencimiento ascendente'
  )

  let saldo = await R.customerBalance(prisma, cliente.id, branchWhere)
  assert(saldo.saldo === 350, 'el saldo del cliente es la suma de lo no cobrado')
  assert(saldo.vencido === 300 && saldo.facturas_vencidas === 2, 'solo V-1 y V-2 cuentan como vencidas')

  // ---- (b) aplicación y estados ----
  const cobro1 = await prisma.$transaction((tx) => R.applyPayment(tx, {
    customerId: cliente.id, branchId: suc.id, amount: 250,
    paymentMethodId: efectivo.id, userId: usuario.id, reference: 'REC-1',
  }))
  assert(
    JSON.stringify(cobro1.applications.map((a) => a.amount)) === JSON.stringify([100, 150]),
    'un cobro de 250 cancela la más vieja (100) y abona 150 a la siguiente'
  )
  const estado = async (id) => (await prisma.sale.findUnique({ where: { id } })).payment_status
  assert(await estado(v1.id) === 'PAID', 'la factura cubierta queda PAID')
  assert(await estado(v2.id) === 'PARTIAL', 'la parcialmente abonada queda PARTIAL')
  assert(await estado(v3.id) === 'PENDING', 'la no tocada sigue PENDING')

  saldo = await R.customerBalance(prisma, cliente.id, branchWhere)
  assert(saldo.saldo === 100, 'el saldo baja exactamente lo cobrado')

  // ---- (c) sobrepago: queda como saldo a favor ----
  const sobrepago = await prisma.$transaction((tx) => R.applyPayment(tx, {
    customerId: cliente.id, branchId: suc.id, amount: 150,
    paymentMethodId: efectivo.id, userId: usuario.id, reference: 'REC-ANT', allowAdvance: true,
  }))
  assert(sobrepago.unapplied === 50, 'confirmado como anticipo, lo que sobra queda sin aplicar')

  // Sin esa confirmación el sobrepago se rechaza: casi siempre es el mismo
  // cobro enviado dos veces, no un anticipo.
  let sinConfirmar = false
  try {
    await prisma.$transaction((tx) => R.applyPayment(tx, {
      customerId: cliente.id, branchId: suc.id, amount: 10,
      paymentMethodId: efectivo.id, userId: usuario.id,
    }))
  } catch (e) {
    sinConfirmar = /excede el saldo/.test(e.message)
  }
  assert(sinConfirmar, 'cobrar de más sin confirmar el anticipo se rechaza')

  saldo = await R.customerBalance(prisma, cliente.id, branchWhere)
  assert(saldo.saldo === 0, 'las facturas abiertas quedan saldadas')
  assert(saldo.credito_disponible === 50, 'el sobrante se reporta como saldo a favor del cliente')
  assert(saldo.saldo_neto === 0, 'el saldo neto no se vuelve negativo')

  // El anticipo se aplica a la factura siguiente, sin mover dinero otra vez.
  const v4 = await ventaCredito(80, 30, 'V-4')
  const anticipoAplicado = await prisma.$transaction((tx) => R.applyAvailableCredit(tx, cliente.id, suc.id))
  assert(anticipoAplicado.reduce((t, a) => t + a.amount, 0) === 50,
    'aplicar el saldo a favor imputa los 50 a la factura nueva')
  assert(await estado(v4.id) === 'PARTIAL', 'la factura nueva queda PARTIAL con el anticipo')
  saldo = await R.customerBalance(prisma, cliente.id, branchWhere)
  assert(saldo.credito_disponible === 0, 'después de aplicarlo ya no queda saldo a favor')
  assert(saldo.saldo === 30, 'y la deuda es el resto de la factura nueva')

  const reAplicado = await prisma.$transaction((tx) => R.applyAvailableCredit(tx, cliente.id, suc.id))
  assert(reAplicado.length === 0, 'volver a aplicar el anticipo no duplica nada')

  // Deja el escenario como estaba para las pruebas que siguen.
  await prisma.customerPayment.delete({ where: { id: sobrepago.paymentId } })
  await prisma.sale.delete({ where: { id: v4.id } })
  for (const v of [v1, v2, v3]) await prisma.$transaction((tx) => R.syncSaleStatus(tx, v.id))
  saldo = await R.customerBalance(prisma, cliente.id, branchWhere)
  assert(saldo.saldo === 100, 'borrar el anticipo devuelve el saldo a como estaba')

  // ---- (c2) aplicación manual ----
  const abiertasManual = await R.openSalesOf(prisma, cliente.id, branchWhere)
  let rechazadoManual = false
  try {
    R.planManual(abiertasManual, [{ sale_id: v3.id, amount: 999 }], 999)
  } catch (e) {
    rechazadoManual = /excede su saldo/.test(e.message)
  }
  assert(rechazadoManual, 'aplicar a una factura más de su saldo se rechaza')

  const manual = R.planManual(abiertasManual, [{ sale_id: v3.id, amount: 20 }], 50)
  assert(manual.applications.length === 1 && manual.applications[0].sale_id === v3.id,
    'la aplicación manual respeta la factura elegida, saltándose el FIFO')
  assert(manual.unapplied === 30, 'lo no asignado a mano queda como saldo a favor')

  // ---- (d) devolución parcial ----
  await prisma.sale.update({
    where: { id: v3.id }, data: { total_returned: '20', adjusted_total: '30' },
  })
  saldo = await R.customerBalance(prisma, cliente.id, branchWhere)
  assert(saldo.saldo === 80, 'devolver mercadería baja la deuda sin registrar ningún abono')

  // ---- (e) borrar el cobro ----
  const pago = await prisma.customerPayment.findFirst({ where: { reference: 'REC-1', branch_id: suc.id } })
  const afectadas = await prisma.salePaymentEntry.findMany({
    where: { customer_payment_id: pago.id }, select: { sale_id: true },
  })
  await prisma.$transaction(async (tx) => {
    await tx.customerPayment.delete({ where: { id: pago.id } })
    for (const a of afectadas) await R.syncSaleStatus(tx, a.sale_id)
  })
  assert(await estado(v1.id) === 'PENDING' && await estado(v2.id) === 'PENDING',
    'borrar el cobro devuelve las facturas a PENDING')
  assert(await prisma.salePaymentEntry.count({ where: { customer_payment_id: pago.id } }) === 0,
    'las aplicaciones se borran en cascada con el recibo')

  // ---- (f) límite de crédito ----
  let chequeo = await R.checkCredit(prisma, cliente, 100, branchWhere)
  assert(chequeo.ok === false && /vencida/.test(chequeo.motivo),
    'con facturas vencidas no se puede seguir fiando')

  await prisma.sale.updateMany({ where: { customer_contact_id: cliente.id }, data: { due_date: dias(30) } })
  chequeo = await R.checkCredit(prisma, cliente, 100, branchWhere)
  assert(chequeo.ok === true, 'sin vencidas y dentro del límite, la venta pasa')

  chequeo = await R.checkCredit(prisma, cliente, 9800, branchWhere)
  assert(chequeo.ok === false && /límite/.test(chequeo.motivo) && chequeo.saldo_resultante === 10130,
    'excederse del límite bloquea e informa el saldo resultante')

  chequeo = await R.checkCredit(prisma, { id: cliente.id, credit_limit: null }, 999999, branchWhere)
  assert(chequeo.ok === true, 'un cliente sin límite configurado nunca bloquea por monto')

  // ---- (i) dos cobros simultáneos no sobre-aplican ----
  // Sin el advisory lock por cliente ambos leen el mismo saldo y la venta queda
  // con abonos por encima de su total.
  const clienteCarrera = await prisma.supplier.create({
    data: { company_id: co.id, party_type: 'CUSTOMER', name: 'Cliente Carrera', contact: 'x' },
  })
  const ventaCarrera = await prisma.sale.create({
    data: {
      branch_id: suc.id, reference: `V-RACE-${Date.now()}`, customer_contact_id: clienteCarrera.id,
      total: '100.00', adjusted_total: '100.00', total_returned: '0', items: 1,
      payment_method_id: credito.id, status_id: completada.id, created_by: usuario.id,
      payment_status: 'PENDING',
    },
  })
  const cobroConcurrente = () => prisma.$transaction((tx) => R.applyPayment(tx, {
    customerId: clienteCarrera.id, branchId: suc.id, amount: 100,
    paymentMethodId: efectivo.id, userId: usuario.id,
  }), { timeout: 20000 })

  const carrera = await Promise.allSettled([cobroConcurrente(), cobroConcurrente()])
  const aceptados = carrera.filter((r) => r.status === 'fulfilled').length
  const aplicado = Number(
    (await prisma.salePaymentEntry.aggregate({
      where: { sale_id: ventaCarrera.id }, _sum: { amount: true },
    }))._sum.amount || 0
  )
  assert(aceptados === 1, `de dos cobros simultáneos por el total solo entra uno — entraron ${aceptados}`)
  assert(Math.abs(aplicado - 100) < 0.005,
    `a la venta se le aplican 100 y no más — se aplicaron ${aplicado}`)
  assert((await prisma.sale.findUnique({ where: { id: ventaCarrera.id } })).payment_status === 'PAID',
    'y queda PAID una sola vez')

  // ---- (h) aislamiento por sucursal ----
  const otra = await prisma.branch.create({ data: { company_id: co.id, name: 'Otra', code: 'OTR' } })
  const saldoOtra = await R.customerBalance(prisma, cliente.id, { branch_id: otra.id })
  assert(saldoOtra.saldo === 0, 'la cartera de otra sucursal no ve estas ventas')

  // ---- (g) contabilidad ----
  const co2 = await prisma.company.create({ data: { name: 'Posteo SA', code: `PX${Date.now() % 100000}` } })
  const suc2 = await prisma.branch.create({
    data: { company_id: co2.id, name: 'Central', code: 'CT2', is_default: true },
  })
  const cliente2 = await prisma.supplier.create({
    data: { company_id: co2.id, party_type: 'CUSTOMER', name: 'Tienda El Sol', contact: 'Don Beto' },
  })
  const cuentas = {}
  const codigos = {}
  for (const [key, code, name, type] of CUENTAS) {
    cuentas[key] = await prisma.account.create({
      data: { company_id: co2.id, code, name, type },
    })
    codigos[key] = code // la configuración mapea a código de cuenta, no a id
  }
  await prisma.systemSetting.create({
    data: { company_id: co2.id, key: 'accounting.defaultAccounts', value: JSON.stringify(codigos) },
  })
  // Pequeño contribuyente: sin desglose de IVA, el asiento queda en su forma mínima.
  await prisma.systemSetting.create({
    data: { company_id: co2.id, key: 'vat_affiliation', value: 'pequeno' },
  })

  const ventaP = await prisma.sale.create({
    data: {
      branch_id: suc2.id, reference: 'V-CR-1', customer_contact_id: cliente2.id,
      total: '1000.00', adjusted_total: '1000.00', total_returned: '0', items: 1,
      payment_method_id: credito.id, status_id: completada.id, created_by: usuario.id,
      payment_status: 'PENDING', due_date: dias(30),
    },
  })
  await postPendingOperations(prisma, usuario.id, co2.id)

  const cuadra = (e) => {
    const d = e.lines.reduce((s, l) => s + Number(l.debit), 0)
    const h = e.lines.reduce((s, l) => s + Number(l.credit), 0)
    return Math.abs(d - h) < 0.005
  }
  const asientoVenta = await prisma.journalEntry.findFirst({
    where: { company_id: co2.id, source_type: 'SALE', source_id: ventaP.id }, include: { lines: true },
  })
  assert(asientoVenta && cuadra(asientoVenta), 'la venta al crédito genera un asiento cuadrado')
  assert(
    asientoVenta.lines.some((l) => l.account_id === cuentas.receivables.id && Number(l.debit) === 1000),
    'la venta al crédito debita Clientes por el total'
  )

  await prisma.$transaction((tx) => R.applyPayment(tx, {
    customerId: cliente2.id, branchId: suc2.id, amount: 1000,
    paymentMethodId: efectivo.id, userId: usuario.id, reference: 'REC-P1',
  }))
  const recibo = await prisma.customerPayment.findFirst({ where: { reference: 'REC-P1', branch_id: suc2.id } })
  await postPendingOperations(prisma, usuario.id, co2.id)

  const asientoCobro = await prisma.journalEntry.findFirst({
    where: { company_id: co2.id, source_type: 'SALE_PAYMENT', source_id: recibo.id }, include: { lines: true },
  })
  assert(asientoCobro && cuadra(asientoCobro), 'el cobro genera un asiento cuadrado')
  assert(
    asientoCobro.lines.some((l) => l.account_id === cuentas.receivables.id && Number(l.credit) === 1000),
    'el cobro acredita Clientes'
  )
  assert(
    asientoCobro.lines.some((l) => l.account_id === cuentas.cash.id && Number(l.debit) === 1000),
    'y debita Caja por haberse cobrado en efectivo'
  )

  const movs = await prisma.journalLine.findMany({
    where: { account_id: cuentas.receivables.id }, select: { debit: true, credit: true },
  })
  const saldoClientes =
    movs.reduce((s, l) => s + Number(l.debit), 0) - movs.reduce((s, l) => s + Number(l.credit), 0)
  assert(Math.abs(saldoClientes) < 0.005,
    'al cobrar toda la deuda la cuenta de Clientes queda en cero: el circuito cierra')

  const antes = await prisma.journalEntry.count({ where: { company_id: co2.id } })
  await postPendingOperations(prisma, usuario.id, co2.id)
  const despues = await prisma.journalEntry.count({ where: { company_id: co2.id } })
  assert(antes === despues, 'reintentar el posteo no duplica asientos')

  // ---- (i) ajustes: nota de crédito e incobrable ----
  // Empresa aparte para poder leer su cuenta de Clientes sin arrastrar los
  // movimientos de las pruebas anteriores.
  const co3 = await prisma.company.create({ data: { name: 'Ajustes SA', code: `AX${Date.now() % 100000}` } })
  const suc3 = await prisma.branch.create({
    data: { company_id: co3.id, name: 'Central', code: 'CT3', is_default: true },
  })
  const cliente3 = await prisma.supplier.create({
    data: { company_id: co3.id, party_type: 'CUSTOMER', name: 'Ferretería El Clavo', contact: 'Don Chus' },
  })
  const cuentas3 = {}
  const codigos3 = {}
  for (const [key, code, name, type] of [...CUENTAS, ['badDebt', '6109', 'Cuentas incobrables', 'EXPENSE']]) {
    cuentas3[key] = await prisma.account.create({ data: { company_id: co3.id, code, name, type } })
    codigos3[key] = code
  }
  await prisma.systemSetting.create({
    data: { company_id: co3.id, key: 'accounting.defaultAccounts', value: JSON.stringify(codigos3) },
  })

  const ventaAj = await prisma.sale.create({
    data: {
      branch_id: suc3.id, reference: 'V-AJ-1', customer_contact_id: cliente3.id,
      total: '1120.00', adjusted_total: '1120.00', total_returned: '0', items: 1,
      payment_method_id: credito.id, status_id: completada.id, created_by: usuario.id,
      payment_status: 'PENDING', due_date: dias(-5),
    },
  })

  // Un ajuste no puede perdonar más de lo que se debe: sería regalar crédito.
  let excede = false
  try {
    await prisma.$transaction((tx) => R.applyPayment(tx, {
      customerId: cliente3.id, branchId: suc3.id, amount: 2000,
      paymentMethodId: null, userId: usuario.id, kind: 'CREDIT_NOTE',
    }))
  } catch (e) {
    excede = /excede el saldo/.test(e.message)
  }
  assert(excede, 'un ajuste mayor a la deuda se rechaza en vez de dejar saldo a favor')

  const nota = await prisma.$transaction((tx) => R.applyPayment(tx, {
    customerId: cliente3.id, branchId: suc3.id, amount: 120,
    paymentMethodId: null, userId: usuario.id, kind: 'CREDIT_NOTE', notes: 'Descuento acordado',
  }))
  assert(nota.unapplied === 0, 'la nota de crédito se aplica completa a la factura')

  const castigo = await prisma.$transaction((tx) => R.applyPayment(tx, {
    customerId: cliente3.id, branchId: suc3.id, amount: 1000,
    paymentMethodId: null, userId: usuario.id, kind: 'WRITE_OFF', notes: 'Cliente ilocalizable',
  }))
  assert(castigo.applications.length === 1, 'el castigo por incobrable también aplica a la factura')

  assert(await estado(ventaAj.id) === 'PAID',
    'entre nota de crédito e incobrable la factura queda saldada')
  const saldo3 = await R.customerBalance(prisma, cliente3.id, { branch_id: suc3.id })
  assert(saldo3.saldo === 0 && saldo3.credito_disponible === 0,
    'los ajustes no dejan saldo ni crédito a favor')

  await postPendingOperations(prisma, usuario.id, co3.id)

  const asientoNota = await prisma.journalEntry.findFirst({
    where: { company_id: co3.id, source_type: 'SALE_PAYMENT', source_id: nota.paymentId },
    include: { lines: true },
  })
  assert(asientoNota && cuadra(asientoNota), 'la nota de crédito genera un asiento cuadrado')
  assert(
    asientoNota.lines.some((l) => l.account_id === cuentas3.salesReturns.id && Number(l.debit) > 0),
    'la nota de crédito debita devoluciones sobre ventas, no Caja'
  )
  assert(
    asientoNota.lines.some((l) => l.account_id === cuentas3.ivaDebit.id && Number(l.debit) > 0),
    'y devuelve el IVA débito de lo que se dejó de cobrar'
  )

  const asientoCastigo = await prisma.journalEntry.findFirst({
    where: { company_id: co3.id, source_type: 'SALE_PAYMENT', source_id: castigo.paymentId },
    include: { lines: true },
  })
  assert(asientoCastigo && cuadra(asientoCastigo), 'el incobrable genera un asiento cuadrado')
  assert(
    asientoCastigo.lines.some((l) => l.account_id === cuentas3.badDebt.id && Number(l.debit) === 1000),
    'el incobrable se lleva a gasto por cuentas incobrables'
  )

  const movs3 = await prisma.journalLine.findMany({
    where: { account_id: cuentas3.receivables.id }, select: { debit: true, credit: true },
  })
  const saldoClientes3 =
    movs3.reduce((t, l) => t + Number(l.debit), 0) - movs3.reduce((t, l) => t + Number(l.credit), 0)
  assert(Math.abs(saldoClientes3) < 0.005,
    'nota de crédito e incobrable dejan la cuenta de Clientes en cero')

  console.log('\ncuentas por cobrar: OK\n')
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
