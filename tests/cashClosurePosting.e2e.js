/**
 * Reporte de QA: un cierre de caja aprobado con diferencia (sobrante/faltante)
 * no generaba ningún asiento contable — "0 operaciones contabilizadas". El
 * motor de posteo no tenía ningún JournalSourceType ni cuentas para esto. Ver
 * postPendingOperations en src/services/accounting/postingEngine.js, sección
 * "Diferencias de arqueo".
 *
 * Cubre: (a) sin cuenta `cashOverShort` configurada, se omite solo el arqueo
 * y el resto de la corrida sigue contabilizando con normalidad; (b) con la
 * cuenta configurada, postea sobrante y faltante correctamente balanceados;
 * (c) diferencia 0 nunca genera asiento; (d) reintentar no duplica.
 *
 * Uso: contra un Postgres desechable ya migrado (incluye la migración
 * 20260826050000_cash_closure_journal_source_type).
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

async function main() {
  const { postPendingOperations } = require('../src/services/accounting/postingEngine')

  const co = await prisma.company.create({ data: { name: 'Arqueo SA', code: `AQ${Date.now() % 100000}` } })
  const suc = await prisma.branch.create({ data: { company_id: co.id, name: 'Central', code: 'CTR', is_default: true } })

  const codigos = {}
  for (const [key, code, name, type] of CUENTAS) {
    await prisma.account.create({ data: { company_id: co.id, code, name, type } })
    codigos[key] = code
  }
  await prisma.systemSetting.create({
    data: { company_id: co.id, key: 'accounting.defaultAccounts', value: JSON.stringify(codigos) },
  })
  await prisma.systemSetting.create({ data: { company_id: co.id, key: 'vat_affiliation', value: 'PEQUENO' } })

  const baseClosure = {
    branch_id: suc.id, cashier_name: 'Cajero', status: 'Aprobado',
    date: new Date(), start_date: new Date(), end_date: new Date(),
    theoretical_total: 100, theoretical_sales: 100, theoretical_returns: 0,
    total_transactions: 1, total_customers: 1, average_ticket: 100,
  }

  console.log('\n== Sin cuenta de arqueo configurada: se omite solo el arqueo ==')
  const sobrante = await prisma.cashClosure.create({
    data: { ...baseClosure, actual_total: 110, difference: 10 },
  })
  const cero = await prisma.cashClosure.create({
    data: { ...baseClosure, actual_total: 100, difference: 0 },
  })
  const r1 = await postPendingOperations(prisma, null, co.id)
  const skipReasonSobrante = r1.skipped.find((s) => s.source.includes(`#${sobrante.closure_number}`))
  assert(!!skipReasonSobrante, 'el sobrante queda listado como omitido')
  assert(/cuenta.*arqueo/i.test(skipReasonSobrante.reason), `el motivo explica que falta la cuenta — dice: "${skipReasonSobrante.reason}"`)
  const skipReasonCero = r1.skipped.find((s) => s.source.includes(`#${cero.closure_number}`))
  assert(skipReasonCero?.reason === 'diferencia 0', 'el de diferencia 0 se omite por eso, no por cuentas')
  const entriesSinCuenta = await prisma.journalEntry.count({ where: { company_id: co.id } })
  assert(entriesSinCuenta === 0, `sin cuenta configurada, cero asientos de arqueo — hay ${entriesSinCuenta}`)

  console.log('\n== Configurar cashOverShort y reintentar: ahora sí postea ==')
  await prisma.account.create({ data: { company_id: co.id, code: '6201', name: 'Sobrante/Faltante de caja', type: 'EXPENSE' } })
  await prisma.systemSetting.update({
    where: { company_id_key: { company_id: co.id, key: 'accounting.defaultAccounts' } },
    data: { value: JSON.stringify({ ...codigos, cashOverShort: '6201' }) },
  })

  const faltante = await prisma.cashClosure.create({
    data: { ...baseClosure, actual_total: 90, difference: -10 },
  })

  const r2 = await postPendingOperations(prisma, null, co.id)
  assert(r2.posted === 2, `postea sobrante y faltante ahora que la cuenta existe — posteó ${r2.posted}`)
  const entries = await prisma.journalEntry.findMany({
    where: { company_id: co.id, source_type: 'CASH_CLOSURE' },
    include: { lines: true },
  })
  assert(entries.length === 2, `dos asientos de arqueo — hay ${entries.length}`)
  for (const e of entries) {
    const debe = e.lines.reduce((s, l) => s + Number(l.debit), 0)
    const haber = e.lines.reduce((s, l) => s + Number(l.credit), 0)
    assert(debe === haber && debe === 10, `asiento ${e.source_id} balanceado en 10 — debe ${debe}, haber ${haber}`)
  }
  const sobranteEntry = entries.find((e) => e.source_id === sobrante.id)
  const cajaLine = sobranteEntry.lines.find((l) => Number(l.debit) === 10)
  assert(!!cajaLine, 'en el sobrante, Caja se debita (entra efectivo)')

  console.log('\n== Reintentar no duplica ==')
  const r3 = await postPendingOperations(prisma, null, co.id)
  assert(r3.posted === 0, `nada nuevo — posteó ${r3.posted}`)
  const entriesFinal = await prisma.journalEntry.count({ where: { company_id: co.id, source_type: 'CASH_CLOSURE' } })
  assert(entriesFinal === 2, `siguen siendo 2 — hay ${entriesFinal}`)

  console.log('\nTODO OK')
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
