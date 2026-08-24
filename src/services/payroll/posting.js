/**
 * Copyright (c) 2026 Diego Patzán. All Rights Reserved.
 *
 * This source code is licensed under a Proprietary License.
 * Unauthorized copying, modification, distribution, or use of this file,
 * via any medium, is strictly prohibited without express written permission.
 *
 * For licensing inquiries: GitHub @dpatzan2
 */

/**
 * Asientos de nómina. Único lugar que conoce el mapeo concepto → cuenta.
 *
 * La idempotencia la da el @@unique([company_id, source_type, source_id]) que
 * JournalEntry ya tiene, pero aquí no se atrapa: cada sitio de posteo ya llega
 * protegido por un reclamo atómico previo (confirm/pay descuentan un
 * `updateMany` que solo un caller gana; un anticipo nuevo no puede repetir su
 * id). Si el índice llegara a saltar de todos modos, la transacción debe
 * abortar limpio — Postgres no permite continuar después de un error dentro
 * de una transacción interactiva, y Prisma no expone savepoints para tragarlo.
 */

const { createEntry, getPayrollAccounts } = require('../accounting/core')
const { round2 } = require('./calc')

/** Suma de los importes de ciertos conceptos en toda la corrida. */
function totalOf(run, concepts) {
  const wanted = new Set(concepts)
  let total = 0
  for (const slip of run.payslips) {
    for (const line of slip.lines) {
      if (wanted.has(line.concept)) total += Number(line.amount)
    }
  }
  return round2(total)
}

/**
 * Devengo de la planilla, al confirmarla.
 *
 *   Debe  6101 Sueldos y Salarios        ordinario + extras + aguinaldo/bono14
 *   Debe  6106 Bonificación Incentivo
 *   Debe  6107 Cuota Patronal            IGSS patronal + IRTRA + INTECAP
 *   Debe  6108 Provisiones Laborales
 *     Haber 2104 IGSS por Pagar          laboral + patronal + IRTRA + INTECAP
 *     Haber 2105 ISR Retenido por Pagar
 *     Haber 2106 Provisiones por Pagar
 *     Haber 1106 Anticipos a Empleados   recuperación de las cuotas
 *     Haber 2107 Sueldos por Pagar       neto
 *
 * IRTRA e INTECAP se acreditan en 2104 porque se recaudan en la misma planilla
 * del IGSS: separarlos obligaría a dos cuentas más que se liquidan juntas.
 */
async function postPayrollRun(tx, { run, userId }) {
  const acc = await getPayrollAccounts(tx, run.company_id)

  const sueldos = totalOf(run, ['SUELDO_ORDINARIO', 'HORAS_EXTRA', 'AGUINALDO', 'BONO14', 'OTRO_DEVENGO'])
  const bonificacion = totalOf(run, ['BONIFICACION_INCENTIVO'])
  const patronal = totalOf(run, ['IGSS_PATRONAL', 'IRTRA', 'INTECAP'])
  const provisiones = totalOf(run, ['PROVISION_AGUINALDO', 'PROVISION_BONO14', 'PROVISION_VACACIONES', 'PROVISION_INDEMNIZACION'])
  const igssLaboral = totalOf(run, ['IGSS_LABORAL'])
  const isr = totalOf(run, ['ISR_RETENIDO'])
  const anticipos = totalOf(run, ['ANTICIPO'])
  const otrasDeducciones = totalOf(run, ['OTRA_DEDUCCION'])
  const neto = round2(run.payslips.reduce((s, p) => s + Number(p.net_pay), 0))

  const lines = []
  const add = (account, debit, credit, description) => {
    const d = round2(debit)
    const c = round2(credit)
    if (d === 0 && c === 0) return // las líneas en cero se omiten
    lines.push({ account_id: account.id, debit: d, credit: c, description })
  }

  add(acc.payrollWagesExpense, sueldos, 0, 'Sueldos y salarios')
  add(acc.payrollBonificacion, bonificacion, 0, 'Bonificación incentivo')
  add(acc.payrollEmployerCost, patronal, 0, 'Cuota patronal IGSS/IRTRA/INTECAP')
  add(acc.payrollProvisionsExpense, provisiones, 0, 'Provisiones laborales')
  add(acc.payrollIgssPayable, 0, round2(igssLaboral + patronal), 'IGSS por pagar')
  add(acc.payrollIsrPayable, 0, isr, 'ISR retenido por pagar')
  add(acc.payrollProvisionsPayable, 0, provisiones, 'Provisiones por pagar')
  add(acc.payrollAdvances, 0, anticipos, 'Recuperación de anticipos')
  // Las «otras deducciones» todavía no tienen cuenta propia: van contra sueldos
  // por pagar, que es donde ya está el neto.
  add(acc.payrollWagesPayable, 0, round2(neto + otrasDeducciones), 'Sueldos por pagar')

  if (lines.length === 0) return null

  return createEntry(tx, {
    company_id: run.company_id,
    branch_id: run.branch_id,
    date: run.pay_date,
    description: `Planilla ${run.code} — ${run.name}`,
    source_type: 'PAYROLL',
    source_id: run.id,
    created_by: userId || null,
    lines,
  })
}

/**
 * Pago de la planilla.
 *   Debe  2107 Sueldos por Pagar
 *     Haber 1102 Bancos
 */
async function postPayrollPayment(tx, { run, userId }) {
  const acc = await getPayrollAccounts(tx, run.company_id)
  const neto = round2(run.payslips.reduce((s, p) => s + Number(p.net_pay), 0))
  if (neto === 0) return null

  return createEntry(tx, {
    company_id: run.company_id,
    branch_id: run.branch_id,
    date: run.pay_date,
    description: `Pago de planilla ${run.code}`,
    source_type: 'PAYROLL_PAYMENT',
    source_id: run.id,
    created_by: userId || null,
    lines: [
      { account_id: acc.payrollWagesPayable.id, debit: neto, credit: 0 },
      { account_id: acc.bank.id, debit: 0, credit: neto },
    ],
  })
}

/**
 * Reversión del devengo al anular una planilla confirmada. Mismo asiento con
 * debe y haber invertidos, ligado al original por `reversal_of_id`. Va con un
 * `source_id` propio porque el índice de idempotencia no admite dos asientos
 * con el mismo (company, source_type, source_id).
 */
async function reversePayrollRun(tx, { run, userId }) {
  const original = await tx.journalEntry.findFirst({
    where: { company_id: run.company_id, source_type: 'PAYROLL', source_id: run.id },
    include: { lines: true },
  })
  if (!original) return null // nunca se posteó: nada que revertir

  return createEntry(tx, {
    company_id: run.company_id,
    branch_id: run.branch_id,
    date: new Date(),
    description: `Anulación de planilla ${run.code}`,
    source_type: 'PAYROLL',
    source_id: `reversal:${run.id}`,
    created_by: userId || null,
    reversal_of_id: original.id,
    lines: original.lines.map((l) => ({
      account_id: l.account_id,
      debit: Number(l.credit),
      credit: Number(l.debit),
      description: l.description,
    })),
  })
}

/**
 * Anticipo otorgado.
 *   Debe  1106 Anticipos a Empleados
 *     Haber 1101 Caja
 *
 * No es opcional: sin él la 1106 solo recibiría los abonos de la planilla y
 * quedaría en negativo.
 */
async function postAdvance(tx, { advance, userId }) {
  const acc = await getPayrollAccounts(tx, advance.company_id)
  const amount = round2(Number(advance.amount))
  if (amount === 0) return null

  return createEntry(tx, {
    company_id: advance.company_id,
    branch_id: advance.branch_id,
    date: advance.date,
    description: 'Anticipo de sueldo a empleado',
    source_type: 'PAYROLL_ADVANCE',
    source_id: advance.id,
    created_by: userId || null,
    lines: [
      { account_id: acc.payrollAdvances.id, debit: amount, credit: 0 },
      { account_id: acc.cash.id, debit: 0, credit: amount },
    ],
  })
}

/** Reversión del anticipo al cancelarlo (solo posible si no se descontó nada). */
async function reverseAdvance(tx, { advance, userId }) {
  const original = await tx.journalEntry.findFirst({
    where: { company_id: advance.company_id, source_type: 'PAYROLL_ADVANCE', source_id: advance.id },
    include: { lines: true },
  })
  if (!original) return null

  return createEntry(tx, {
    company_id: advance.company_id,
    branch_id: advance.branch_id,
    date: new Date(),
    description: 'Anulación de anticipo de sueldo',
    source_type: 'PAYROLL_ADVANCE',
    source_id: `reversal:${advance.id}`,
    created_by: userId || null,
    reversal_of_id: original.id,
    lines: original.lines.map((l) => ({
      account_id: l.account_id,
      debit: Number(l.credit),
      credit: Number(l.debit),
      description: l.description,
    })),
  })
}

module.exports = { postPayrollRun, postPayrollPayment, reversePayrollRun, postAdvance, reverseAdvance }
