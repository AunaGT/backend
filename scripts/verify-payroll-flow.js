#!/usr/bin/env node
/**
 * Copyright (c) 2026 Diego Patzán. All Rights Reserved.
 *
 * Prueba de integración end-to-end de RRHH + nómina contra una Postgres
 * desechable. Ejercita los controllers reales, no mocks de lógica de negocio.
 *
 * Solo para correr contra una base descartable (DATABASE_URL apunta a ella).
 * Sale con código 1 si alguna aserción falla.
 *
 * Correr: node scripts/verify-payroll-flow.js
 */

const { prisma } = require('../src/models/prisma')
const employeesCtrl = require('../src/controllers/hrEmployees.controller')
const attendanceCtrl = require('../src/controllers/hrAttendance.controller')
const advancesCtrl = require('../src/controllers/hrAdvances.controller')
const payrollCtrl = require('../src/controllers/payroll.controller')
const transitionsCtrl = require('../src/controllers/payrollTransitions.controller')

let failures = 0
function assert(cond, label) {
  if (cond) {
    console.log(`  OK  ${label}`)
  } else {
    failures++
    console.log(`  FAIL  ${label}`)
  }
}

/**
 * Igual que el error handler global de Express: un error con .status se traduce
 * a esa respuesta HTTP, no a un reject, así el test lee status/body como el
 * cliente real.
 */
function call(fn, req) {
  return new Promise((resolve) => {
    let done = false
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this },
      json(body) { if (!done) { done = true; resolve({ status: this.statusCode, body }) } },
    }
    const toResponse = (e) => ({ status: e?.status || 500, body: { message: e?.message || String(e) } })
    const next = (err) => { if (!done) { done = true; resolve(toResponse(err)) } }
    Promise.resolve(fn(req, res, next)).catch((e) => { if (!done) { done = true; resolve(toResponse(e)) } })
  })
}

const round2 = (n) => Math.round(n * 100) / 100

async function entryFor(companyId, sourceType, sourceId) {
  return prisma.journalEntry.findFirst({
    where: { company_id: companyId, source_type: sourceType, source_id: sourceId },
    include: { lines: true },
  })
}

function balanced(entry) {
  const debit = entry.lines.reduce((s, l) => s + Number(l.debit), 0)
  const credit = entry.lines.reduce((s, l) => s + Number(l.credit), 0)
  return Math.abs(debit - credit) < 0.01
}

async function main() {
  const company = await prisma.company.findFirst()
  const branch = await prisma.branch.findFirst({ where: { company_id: company.id } })
  if (!company || !branch) throw new Error('La base desechable no está sembrada: corre npm run seed')

  const req = {
    companyId: company.id,
    branchId: branch.id,
    branchIds: [branch.id],
    userBranchIds: [branch.id],
    user: { sub: null },
    query: {}, params: {}, body: {},
  }

  console.log('== 1. Alta de empleado ==')
  const created = await call(employeesCtrl.create, {
    ...req,
    body: { first_name: 'Gabriela', last_name: 'Ordóñez', hire_date: '2026-01-01', base_salary: 3500, bonificacion_incentivo: 250 },
  })
  assert(created.status === 201, `empleado creado (${created.body.code || created.body.message})`)
  const employee = created.body

  console.log('== 2. Anticipo y su asiento ==')
  const advanceRes = await call(advancesCtrl.create, {
    ...req, body: { employee_id: employee.id, amount: 1000, installment: 250, date: '2026-08-01' },
  })
  assert(advanceRes.status === 201, 'anticipo otorgado')
  const advance = advanceRes.body
  assert(Number(advance.balance) === 1000, 'el saldo arranca en el monto otorgado')
  const advanceEntry = await entryFor(company.id, 'PAYROLL_ADVANCE', advance.id)
  assert(advanceEntry !== null, 'el anticipo generó asiento PAYROLL_ADVANCE')
  assert(advanceEntry !== null && balanced(advanceEntry), 'el asiento del anticipo cuadra')

  console.log('== 3. Asistencia del mes ==')
  await call(attendanceCtrl.upsert, { ...req, body: { employee_id: employee.id, work_date: '2026-08-04', check_in: '08:00', check_out: '19:00', overtime_hours: 4 } })
  const marks = await call(attendanceCtrl.list, { ...req, query: { from: '2026-08-01', to: '2026-08-31', employee_id: employee.id } })
  assert(marks.body.items.length === 1, 'la marca de asistencia quedó registrada')

  console.log('== 4. Generación de la corrida ==')
  const runRes = await call(payrollCtrl.create, {
    ...req, body: { name: 'Agosto 2026', type: 'ORDINARIA', period_start: '2026-08-01', period_end: '2026-08-31', pay_date: '2026-08-31' },
  })
  assert(runRes.status === 201, `corrida generada (${runRes.body.code || runRes.body.message})`)
  const run = runRes.body
  assert(run.status === 'BORRADOR', 'la corrida nace en BORRADOR')
  const slip = run.payslips.find((p) => p.employee_id === employee.id)
  assert(slip !== undefined, 'el empleado tiene recibo')
  const overtimeLine = slip.lines.find((l) => l.concept === 'HORAS_EXTRA')
  assert(overtimeLine !== undefined && Number(overtimeLine.quantity) === 4, 'las horas extra se pre-llenaron desde la asistencia')
  assert(overtimeLine !== undefined && Number(overtimeLine.amount) === 87.5, 'la hora extra se pagó al 150%')
  const igssLine = slip.lines.find((l) => l.concept === 'IGSS_LABORAL')
  assert(Number(slip.igss_base) === 3587.5, 'la base del IGSS excluye la bonificación incentivo')
  assert(igssLine !== undefined && Number(igssLine.amount) === 173.28, 'el IGSS laboral es el 4.83% de la base')
  const sumBy = (type) => round2(slip.lines.filter((l) => l.type === type).reduce((s, l) => s + Number(l.amount), 0))
  assert(sumBy('DEVENGO') === Number(slip.total_earnings), 'los devengos cuadran con el encabezado del recibo')
  assert(sumBy('DEDUCCION') === Number(slip.total_deductions), 'las deducciones cuadran con el encabezado')
  assert(round2(Number(slip.total_earnings) - Number(slip.total_deductions)) === Number(slip.net_pay), 'el neto cuadra')
  const advanceMid = await prisma.employeeAdvance.findUnique({ where: { id: advance.id } })
  assert(Number(advanceMid.balance) === 1000, 'el borrador no toca el saldo del anticipo')

  console.log('== 5. Confirmación ==')
  const confirmed = await call(transitionsCtrl.confirm, { ...req, params: { id: run.id } })
  assert(confirmed.body.status === 'CONFIRMADA', 'la corrida quedó CONFIRMADA')
  const advanceAfter = await prisma.employeeAdvance.findUnique({ where: { id: advance.id } })
  assert(Number(advanceAfter.balance) === 750, 'el anticipo bajó a Q750')
  assert(advanceAfter.status === 'PENDIENTE', 'el anticipo sigue pendiente')
  const runEntry = await entryFor(company.id, 'PAYROLL', run.id)
  assert(runEntry !== null, 'confirmar generó asiento PAYROLL')
  assert(runEntry !== null && balanced(runEntry), 'el asiento de la planilla cuadra')

  console.log('== 6. Pago ==')
  const paid = await call(transitionsCtrl.pay, { ...req, params: { id: run.id } })
  assert(paid.body.status === 'PAGADA', 'la corrida quedó PAGADA')
  const paymentEntry = await entryFor(company.id, 'PAYROLL_PAYMENT', run.id)
  assert(paymentEntry !== null, 'pagar generó asiento PAYROLL_PAYMENT')
  assert(paymentEntry !== null && balanced(paymentEntry), 'el asiento del pago cuadra')
  const cancelPaid = await call(transitionsCtrl.cancel, { ...req, params: { id: run.id } })
  assert(cancelPaid.status === 409, 'una planilla pagada no se puede anular')

  console.log('== 7. Anulación de una confirmada (y regresión de fecha del asiento) ==')
  // pay_date = 2026-09-01: antes del fix, el asiento se fechaba con un Date crudo que
  // al pasar por la zona de Guatemala (UTC-6) retrocedía al 31/08, y el asiento caía
  // en el período contable 08/2026 en vez de 09/2026. Es el caso de regresión pedido.
  const run2 = (await call(payrollCtrl.create, {
    ...req, body: { name: 'Septiembre 2026', period_start: '2026-09-01', period_end: '2026-09-30', pay_date: '2026-09-01' },
  })).body
  await call(transitionsCtrl.confirm, { ...req, params: { id: run2.id } })
  const descontado = await prisma.employeeAdvance.findUnique({ where: { id: advance.id } })
  assert(Number(descontado.balance) === 500, 'la segunda corrida descontó otra cuota')
  const run2Entry = await entryFor(company.id, 'PAYROLL', run2.id)
  assert(run2Entry !== null, 'la corrida de septiembre generó asiento PAYROLL')
  assert(run2Entry !== null && run2Entry.date.getUTCFullYear() === 2026 && run2Entry.date.getUTCMonth() + 1 === 9,
    `el asiento de pay_date 2026-09-01 queda fechado en septiembre, no agosto (quedó en ${run2Entry ? `${run2Entry.date.getUTCFullYear()}-${run2Entry.date.getUTCMonth() + 1}` : 'null'})`)
  const period09 = await prisma.accountingPeriod.findUnique({ where: { company_id_year_month: { company_id: company.id, year: 2026, month: 9 } } })
  assert(period09 !== null, 'se abrió el período contable 09/2026 para ese asiento, no 08/2026')

  const cancelled = await call(transitionsCtrl.cancel, { ...req, params: { id: run2.id } })
  assert(cancelled.body.status === 'ANULADA', 'la corrida quedó ANULADA')
  const restored = await prisma.employeeAdvance.findUnique({ where: { id: advance.id } })
  assert(Number(restored.balance) === 750, 'anular restituyó el saldo EXACTO que se descontó')
  const reversal = await entryFor(company.id, 'PAYROLL', `reversal:${run2.id}`)
  assert(reversal !== null, 'anular generó el asiento de reversión')
  assert(reversal !== null && reversal.reversal_of_id !== null, 'la reversión apunta al asiento original')
  assert(reversal !== null && balanced(reversal), 'el asiento de reversión cuadra')

  console.log('== 8. Doble confirmación concurrente ==')
  const run3 = (await call(payrollCtrl.create, {
    ...req, body: { name: 'Octubre 2026', period_start: '2026-10-01', period_end: '2026-10-31', pay_date: '2026-10-31' },
  })).body
  const saldoAntes = Number((await prisma.employeeAdvance.findUnique({ where: { id: advance.id } })).balance)
  const [a, b] = await Promise.all([
    call(transitionsCtrl.confirm, { ...req, params: { id: run3.id } }),
    call(transitionsCtrl.confirm, { ...req, params: { id: run3.id } }),
  ])
  const oks = [a, b].filter((r) => r.status === 200).length
  const conflicts = [a, b].filter((r) => r.status === 409).length
  assert(oks === 1, `exactamente una confirmación responde 200 (fueron ${oks})`)
  assert(conflicts === 1, `la otra responde 409 (fueron ${conflicts})`)
  const saldoDespues = Number((await prisma.employeeAdvance.findUnique({ where: { id: advance.id } })).balance)
  assert(round2(saldoAntes - saldoDespues) === 250, 'el anticipo se descontó una sola vez')
  const entries3 = await prisma.journalEntry.count({ where: { company_id: company.id, source_type: 'PAYROLL', source_id: run3.id } })
  assert(entries3 === 1, `se posteó un solo asiento (fueron ${entries3})`)

  console.log('== 9. Aguinaldo: carga la provisión (2106), no el gasto de sueldos (6101) ==')
  const runAguinaldoRes = await call(payrollCtrl.create, {
    ...req,
    body: { name: 'Aguinaldo 2026', type: 'AGUINALDO', period_start: '2026-01-01', period_end: '2026-11-30', pay_date: '2026-12-01' },
  })
  assert(runAguinaldoRes.status === 201, `corrida de aguinaldo generada (${runAguinaldoRes.body.code || runAguinaldoRes.body.message})`)
  const runAguinaldo = runAguinaldoRes.body
  const slipAguinaldo = runAguinaldo.payslips.find((p) => p.employee_id === employee.id)
  const aguinaldoLine = slipAguinaldo && slipAguinaldo.lines.find((l) => l.concept === 'AGUINALDO')
  assert(aguinaldoLine !== undefined && Number(aguinaldoLine.amount) > 0, 'el recibo trae la línea de aguinaldo')
  const confirmAguinaldo = await call(transitionsCtrl.confirm, { ...req, params: { id: runAguinaldo.id } })
  assert(confirmAguinaldo.body.status === 'CONFIRMADA', 'la corrida de aguinaldo se confirmó')
  const aguinaldoEntry = await entryFor(company.id, 'PAYROLL', runAguinaldo.id)
  assert(aguinaldoEntry !== null && balanced(aguinaldoEntry), 'el asiento de aguinaldo cuadra')
  const account2106 = await prisma.account.findUnique({ where: { company_id_code: { company_id: company.id, code: '2106' } } })
  const account6101 = await prisma.account.findUnique({ where: { company_id_code: { company_id: company.id, code: '6101' } } })
  const line2106Debit = aguinaldoEntry && aguinaldoEntry.lines.find((l) => l.account_id === account2106.id && Number(l.debit) > 0)
  assert(line2106Debit !== undefined && round2(Number(line2106Debit.debit)) === round2(Number(aguinaldoLine.amount)),
    `el aguinaldo debita la cuenta 2106 (provisión) por ${aguinaldoLine ? aguinaldoLine.amount : '?'}`)
  const line6101InEntry = aguinaldoEntry && aguinaldoEntry.lines.find((l) => l.account_id === account6101.id)
  assert(line6101InEntry === undefined, 'el aguinaldo NO debita la cuenta 6101 (sueldos y salarios)')

  console.log('== 10. Cuota de anticipo topada al neto disponible del recibo ==')
  const createdBig = await call(employeesCtrl.create, {
    ...req,
    body: { first_name: 'Marta', last_name: 'Cifuentes', hire_date: '2026-01-01', base_salary: 3000, bonificacion_incentivo: 250 },
  })
  assert(createdBig.status === 201, 'segundo empleado creado para probar el tope de la cuota')
  const employeeBig = createdBig.body
  const bigAdvanceRes = await call(advancesCtrl.create, {
    ...req, body: { employee_id: employeeBig.id, amount: 5000, installment: 4000, date: '2026-10-01' },
  })
  assert(bigAdvanceRes.status === 201, 'anticipo mayor que el sueldo otorgado')
  const bigAdvance = bigAdvanceRes.body

  const runCap = (await call(payrollCtrl.create, {
    ...req, body: { name: 'Octubre 2026 - Marta', type: 'ORDINARIA', period_start: '2026-10-01', period_end: '2026-10-31', pay_date: '2026-10-31' },
  })).body
  const slipCap = runCap.payslips.find((p) => p.employee_id === employeeBig.id)
  assert(slipCap !== undefined, 'Marta tiene recibo en la corrida de octubre')
  const cuotaLine = slipCap && slipCap.lines.find((l) => l.concept === 'ANTICIPO')
  assert(cuotaLine !== undefined, 'se aplicó una cuota de anticipo aunque topada')
  assert(cuotaLine !== undefined && Number(cuotaLine.amount) < 4000, `la cuota se topó por debajo de la cuota pactada de Q4000 (quedó en ${cuotaLine ? cuotaLine.amount : '?'})`)
  assert(slipCap !== undefined && Number(slipCap.net_pay) >= 0, `el recibo de Marta no queda en negativo (net_pay = ${slipCap ? slipCap.net_pay : '?'})`)
  const confirmCap = await call(transitionsCtrl.confirm, { ...req, params: { id: runCap.id } })
  assert(confirmCap.status === 200 && confirmCap.body.status === 'CONFIRMADA', `la corrida con el anticipo topado confirma limpio (status ${confirmCap.status})`)
  const bigAdvanceAfter = await prisma.employeeAdvance.findUnique({ where: { id: bigAdvance.id } })
  assert(round2(5000 - Number(bigAdvanceAfter.balance)) === round2(Number(cuotaLine.amount)), 'el saldo del anticipo bajó exactamente lo topado, no la cuota pactada completa')

  console.log('== 11. La cuenta de anticipos no queda en negativo ==')
  const account1106 = await prisma.account.findUnique({ where: { company_id_code: { company_id: company.id, code: '1106' } } })
  const totals = await prisma.journalLine.aggregate({ where: { account_id: account1106.id }, _sum: { debit: true, credit: true } })
  const saldo1106 = round2(Number(totals._sum.debit || 0) - Number(totals._sum.credit || 0))
  assert(saldo1106 >= 0, `la 1106 quedó en ${saldo1106}`)

  console.log(failures === 0 ? '\nverify-payroll-flow OK' : `\nverify-payroll-flow: ${failures} fallo(s)`)
}

main()
  .then(() => process.exit(failures === 0 ? 0 : 1))
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
