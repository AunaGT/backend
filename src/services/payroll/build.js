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
 * Arma el recibo de un empleado: sus líneas y sus totales. Puro igual que
 * `calc.js` — el controller le pasa los acumulados ya consultados.
 */

const {
  round2, proratedDays, proratedAmount, overtimePay, igssBase, igssEmployee,
  employerCost, provisions, annualBonus, bonusTaxableExcess, isrWithholding,
} = require('./calc')

/** Las fechas se guardan como DATE, así que el mes en UTC es el mes real. */
const monthOf = (date) => date.getUTCMonth() + 1

/**
 * @param {object} p
 * @param {{ base_salary, bonificacion_incentivo, hire_date, termination_date }} p.employee
 * @param {{ type, period_start, period_end, pay_date }} p.run
 * @param {object} p.rates
 * @param {number} p.overtimeHours horas extra del período (sugeridas por la asistencia, editables)
 * @param {Array<{ id, installment, balance }>} p.advances anticipos pendientes
 * @param {{ taxable, igss, isr }} p.ytd acumulados del año en corridas confirmadas o pagadas
 */
function buildPayslip({ employee, run, rates, overtimeHours = 0, advances = [], ytd = { taxable: 0, igss: 0, isr: 0 } }) {
  const lines = []
  /** Las líneas en cero no se guardan: ensucian el recibo y el asiento. */
  const push = (concept, type, description, amount, extra = {}) => {
    const value = round2(amount)
    if (value === 0) return
    lines.push({
      concept,
      type,
      description,
      quantity: extra.quantity ?? null,
      amount: value,
      advance_id: extra.advance_id ?? null,
      sort_order: lines.length,
    })
  }

  const baseSalary = Number(employee.base_salary)
  // Sin número de IGSS no está afiliado, así que no va en la planilla del IGSS:
  // ni cuota laboral, ni patronal, ni IRTRA, ni INTECAP (esas dos se pagan por
  // la misma planilla). Las provisiones sí siguen: son del Código de Trabajo.
  const afiliadoIgss = Boolean(String(employee.igss_number ?? '').trim())
  const days = proratedDays({
    periodStart: run.period_start,
    periodEnd: run.period_end,
    hireDate: employee.hire_date,
    terminationDate: employee.termination_date,
  })

  let igss_base = 0
  let isr_base = 0

  if (run.type === 'ORDINARIA') {
    const ordinary = proratedAmount(baseSalary, days)
    const bonificacion = proratedAmount(Number(employee.bonificacion_incentivo), days)
    const overtime = overtimePay(baseSalary, overtimeHours, rates.horaExtraFactor)

    push('SUELDO_ORDINARIO', 'DEVENGO', 'Sueldo ordinario', ordinary, { quantity: days })
    push('BONIFICACION_INCENTIVO', 'DEVENGO', 'Bonificación incentivo', bonificacion)
    push('HORAS_EXTRA', 'DEVENGO', 'Horas extra', overtime, { quantity: round2(overtimeHours) })

    igss_base = afiliadoIgss ? igssBase({ ordinary, overtime }) : 0
    isr_base = round2(ordinary + bonificacion + overtime)

    const igssEmp = igssEmployee(igss_base, rates)
    push('IGSS_LABORAL', 'DEDUCCION', `IGSS laboral (${round2(rates.igssLaboral * 100)}%)`, igssEmp)

    const isr = isrWithholding({
      month: monthOf(run.pay_date),
      taxableYTD: ytd.taxable,
      igssYTD: ytd.igss,
      isrWithheldYTD: ytd.isr,
      monthlyTaxable: isr_base,
      monthlyIgss: igssEmp,
    }, rates)
    push('ISR_RETENIDO', 'DEDUCCION', 'ISR retenido', isr)

    // La cuota no puede comerse más de lo que el empleado devengó neto hasta acá
    // (devengos menos IGSS laboral e ISR, las únicas deducciones que van antes):
    // si el saldo no alcanza, se amortiza más lento en vez de dejar el recibo en negativo.
    let disponible = round2(
      lines.filter((l) => l.type === 'DEVENGO').reduce((s, l) => s + l.amount, 0) -
      lines.filter((l) => l.type === 'DEDUCCION').reduce((s, l) => s + l.amount, 0)
    )
    for (const advance of advances) {
      if (disponible <= 0) break
      const cuota = Math.min(round2(advance.installment), round2(advance.balance), disponible)
      if (cuota <= 0) continue
      push('ANTICIPO', 'DEDUCCION', 'Cuota de anticipo', cuota, { advance_id: advance.id })
      disponible = round2(disponible - cuota)
    }

    // Con igss_base en 0 los tres salen en 0 y `push` no los agrega.
    const employer = employerCost(igss_base, rates)
    push('IGSS_PATRONAL', 'COSTO_PATRONAL', 'IGSS cuota patronal', employer.igss)
    push('IRTRA', 'COSTO_PATRONAL', 'IRTRA', employer.irtra)
    push('INTECAP', 'COSTO_PATRONAL', 'INTECAP', employer.intecap)

    const prov = provisions(ordinary, rates)
    push('PROVISION_AGUINALDO', 'COSTO_PATRONAL', 'Provisión aguinaldo', prov.aguinaldo)
    push('PROVISION_BONO14', 'COSTO_PATRONAL', 'Provisión bono 14', prov.bono14)
    push('PROVISION_VACACIONES', 'COSTO_PATRONAL', 'Provisión vacaciones', prov.vacaciones)
    push('PROVISION_INDEMNIZACION', 'COSTO_PATRONAL', 'Provisión indemnización', prov.indemnizacion)
  } else {
    // Aguinaldo y bono 14: no llevan IGSS ni retención de ISR. El excedente
    // gravable sobre un sueldo ordinario se acumula y lo absorbe la siguiente
    // corrida ordinaria vía la proyección autocorrectiva. Tampoco descuentan
    // anticipos ni generan provisiones (esas ya se provisionaron mes a mes).
    const isAguinaldo = run.type === 'AGUINALDO'
    const amount = annualBonus({
      baseSalary,
      periodStart: run.period_start,
      periodEnd: run.period_end,
      hireDate: employee.hire_date,
      terminationDate: employee.termination_date,
    })
    push(isAguinaldo ? 'AGUINALDO' : 'BONO14', 'DEVENGO', isAguinaldo ? 'Aguinaldo' : 'Bono 14', amount)
    isr_base = bonusTaxableExcess(amount, baseSalary)
  }

  const sum = (type) => round2(lines.filter((l) => l.type === type).reduce((s, l) => s + l.amount, 0))
  const total_earnings = sum('DEVENGO')
  const total_deductions = sum('DEDUCCION')
  const employer_cost = sum('COSTO_PATRONAL')

  return {
    days_worked: days,
    igss_base,
    isr_base,
    total_earnings,
    total_deductions,
    net_pay: round2(total_earnings - total_deductions),
    employer_cost,
    lines,
  }
}

module.exports = { buildPayslip }
