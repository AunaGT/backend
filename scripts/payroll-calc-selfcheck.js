/**
 * Copyright (c) 2026 Diego Patzán. All Rights Reserved.
 *
 * Self-check del motor de nómina (lógica pura, sin DB).
 * Correr: node scripts/payroll-calc-selfcheck.js
 */

const assert = require('node:assert')
const {
  round2, daysInclusive, proratedDays, proratedAmount, hourlyRate, overtimePay,
  igssBase, igssEmployee, employerCost, provisions, annualBonus, bonusTaxableExcess,
  annualIsr, isrWithholding,
} = require('../src/services/payroll/calc')
const { DEFAULT_RATES } = require('../src/services/payroll/rates')
const { buildPayslip } = require('../src/services/payroll/build')

const R = DEFAULT_RATES
const d = (s) => new Date(`${s}T12:00:00-06:00`)

// ---- Días y prorrateo (mes comercial de 30 días) ----
assert.strictEqual(daysInclusive(d('2026-08-01'), d('2026-08-31')), 31)
assert.strictEqual(daysInclusive(d('2026-08-05'), d('2026-08-05')), 1)
assert.strictEqual(daysInclusive(d('2026-08-10'), d('2026-08-05')), 0)

// Mes completo = 30 días comerciales, sin importar que el mes tenga 31 o 28
assert.strictEqual(proratedDays({ periodStart: d('2026-08-01'), periodEnd: d('2026-08-31'), hireDate: d('2025-01-01'), terminationDate: null }), 30)
assert.strictEqual(proratedDays({ periodStart: d('2026-02-01'), periodEnd: d('2026-02-28'), hireDate: d('2025-01-01'), terminationDate: null }), 30)
// Alta a mitad de un mes de 30 días: 15 días trabajados = 15 comerciales
assert.strictEqual(proratedDays({ periodStart: d('2026-06-01'), periodEnd: d('2026-06-30'), hireDate: d('2026-06-16'), terminationDate: null }), 15)
// Baja a mitad de período
assert.strictEqual(proratedDays({ periodStart: d('2026-06-01'), periodEnd: d('2026-06-30'), hireDate: d('2020-01-01'), terminationDate: d('2026-06-15') }), 15)
// Empleado que ingresa después del período: no le toca nada
assert.strictEqual(proratedDays({ periodStart: d('2026-06-01'), periodEnd: d('2026-06-30'), hireDate: d('2026-07-01'), terminationDate: null }), 0)

assert.strictEqual(proratedAmount(3500, 30), 3500)
assert.strictEqual(proratedAmount(3500, 15), 1750)

// ---- Horas extra al 150% (Art. 121 Código de Trabajo) ----
assert.ok(Math.abs(hourlyRate(3500) - 14.583333) < 1e-5)
assert.strictEqual(overtimePay(3500, 4, R.horaExtraFactor), 87.5)
assert.strictEqual(overtimePay(3500, 0, R.horaExtraFactor), 0)

// ---- IGSS: la bonificación incentivo NO forma parte de la base (Decreto 78-89) ----
assert.strictEqual(igssBase({ ordinary: 3500, overtime: 0 }), 3500) // 3750 sería incluir la bonificación: incorrecto
assert.strictEqual(igssBase({ ordinary: 3500, overtime: 87.5 }), 3587.5)
assert.strictEqual(igssEmployee(3587.5, R), 173.28)

const patronal = employerCost(3587.5, R)
assert.strictEqual(patronal.igss, 382.79)
assert.strictEqual(patronal.irtra, 35.88)
assert.strictEqual(patronal.intecap, 35.88)
// El total es la suma de los tres redondeados, porque así van al asiento línea por línea
assert.strictEqual(patronal.total, 454.55)

// ---- Provisiones patronales sobre el ordinario ----
const prov = provisions(3500, R)
assert.strictEqual(prov.aguinaldo, 291.55)
assert.strictEqual(prov.bono14, 291.55)
assert.strictEqual(prov.vacaciones, 145.95)
assert.strictEqual(prov.indemnizacion, 340.2)
assert.strictEqual(prov.total, 1069.25)

// ---- ISR: tramos y continuidad en el borde de Q300,000 ----
assert.strictEqual(annualIsr(0, R), 0)
assert.strictEqual(annualIsr(300000, R), 15000)
assert.strictEqual(annualIsr(300001, R), 15000.07)
assert.ok(Math.abs(annualIsr(300000, R) - annualIsr(299999.99, R)) < 0.01, 'el tramo debe ser continuo')

// Un sueldo de Q3,500 + Q250 no llega a pagar ISR: la deducción única se lo come
assert.strictEqual(
  isrWithholding({ month: 1, taxableYTD: 0, igssYTD: 0, isrWithheldYTD: 0, monthlyTaxable: 3750, monthlyIgss: 169.05 }, R),
  0,
)
// Un sueldo de Q15,000 sí retiene
assert.strictEqual(
  isrWithholding({ month: 1, taxableYTD: 0, igssYTD: 0, isrWithheldYTD: 0, monthlyTaxable: 15000, monthlyIgss: 724.5 }, R),
  513.78,
)
// Nunca retención negativa, aunque ya se haya retenido de más
assert.strictEqual(
  isrWithholding({ month: 12, taxableYTD: 165000, igssYTD: 7969.5, isrWithheldYTD: 99999, monthlyTaxable: 15000, monthlyIgss: 724.5 }, R),
  0,
)

// La proyección se autocorrige: doce meses de retención suman el ISR anual
{
  let taxableYTD = 0, igssYTD = 0, isrYTD = 0
  const monthlyTaxable = 15000
  const monthlyIgss = round2(15000 * R.igssLaboral)
  for (let month = 1; month <= 12; month++) {
    isrYTD += isrWithholding({ month, taxableYTD, igssYTD, isrWithheldYTD: isrYTD, monthlyTaxable, monthlyIgss }, R)
    taxableYTD += monthlyTaxable
    igssYTD += monthlyIgss
  }
  const esperado = annualIsr(round2(12 * monthlyTaxable - R.isrDeduccionUnica - 12 * monthlyIgss), R)
  assert.ok(Math.abs(isrYTD - esperado) < 0.5, `retención anual ${isrYTD} vs esperado ${esperado}`)
}

// ---- Aguinaldo / bono 14 proporcionales ----
// Año completo = un sueldo
assert.strictEqual(
  annualBonus({ baseSalary: 3500, periodStart: d('2025-12-01'), periodEnd: d('2026-11-30'), hireDate: d('2020-01-01'), terminationDate: null }),
  3500,
)
// Ingreso el 1 de junio: 183 de 365 días
assert.strictEqual(
  annualBonus({ baseSalary: 3500, periodStart: d('2025-12-01'), periodEnd: d('2026-11-30'), hireDate: d('2026-06-01'), terminationDate: null }),
  1754.79,
)

// Art. 68 Decreto 10-2012: exento hasta un sueldo ordinario, el excedente grava
assert.strictEqual(bonusTaxableExcess(3500, 3500), 0)
assert.strictEqual(bonusTaxableExcess(5000, 3500), 1500)

// ---- Recibo completo ----
const empleado = { base_salary: 3500, bonificacion_incentivo: 250, hire_date: d('2020-01-01'), termination_date: null }

{
  const ordinaria = buildPayslip({
    employee: empleado,
    run: { type: 'ORDINARIA', period_start: d('2026-08-01'), period_end: d('2026-08-31'), pay_date: d('2026-08-31') },
    rates: R,
    overtimeHours: 4,
    advances: [{ id: 'adv-1', installment: 250, balance: 1000 }],
    ytd: { taxable: 0, igss: 0, isr: 0 },
  })

  assert.strictEqual(ordinaria.days_worked, 30)
  assert.strictEqual(ordinaria.igss_base, 3587.5)
  assert.strictEqual(ordinaria.isr_base, 3837.5) // 3500 + 250 + 87.50
  assert.strictEqual(ordinaria.total_earnings, 3837.5)
  assert.strictEqual(ordinaria.total_deductions, 423.28) // IGSS 173.28 + anticipo 250, sin ISR
  assert.strictEqual(ordinaria.net_pay, 3414.22)
  assert.strictEqual(ordinaria.employer_cost, round2(454.55 + provisions(3500, R).total))

  // El desglose tiene que cuadrar con los totales del encabezado
  const suma = (t) => round2(ordinaria.lines.filter((l) => l.type === t).reduce((s, l) => s + l.amount, 0))
  assert.strictEqual(suma('DEVENGO'), ordinaria.total_earnings)
  assert.strictEqual(suma('DEDUCCION'), ordinaria.total_deductions)
  assert.strictEqual(suma('COSTO_PATRONAL'), ordinaria.employer_cost)

  // La cuota de anticipo lleva su advance_id para poder restituir el saldo exacto
  const cuota = ordinaria.lines.find((l) => l.concept === 'ANTICIPO')
  assert.strictEqual(cuota.advance_id, 'adv-1')
  assert.strictEqual(cuota.amount, 250)
  // Nunca se descuenta más que el saldo
  const casiPagado = buildPayslip({
    employee: empleado,
    run: { type: 'ORDINARIA', period_start: d('2026-08-01'), period_end: d('2026-08-31'), pay_date: d('2026-08-31') },
    rates: R, overtimeHours: 0, advances: [{ id: 'adv-2', installment: 250, balance: 80 }], ytd: { taxable: 0, igss: 0, isr: 0 },
  })
  assert.strictEqual(casiPagado.lines.find((l) => l.concept === 'ANTICIPO').amount, 80)

  // Ninguna línea en cero
  assert.ok(ordinaria.lines.every((l) => l.amount !== 0), 'las líneas en cero no se guardan')
}

{
  // Aguinaldo: sin IGSS ni ISR, y el excedente gravable queda en isr_base
  const aguinaldo = buildPayslip({
    employee: empleado,
    run: { type: 'AGUINALDO', period_start: d('2025-12-01'), period_end: d('2026-11-30'), pay_date: d('2026-12-10') },
    rates: R, overtimeHours: 0, advances: [{ id: 'adv-3', installment: 250, balance: 1000 }], ytd: { taxable: 0, igss: 0, isr: 0 },
  })
  assert.strictEqual(aguinaldo.total_earnings, 3500)
  assert.strictEqual(aguinaldo.total_deductions, 0, 'aguinaldo no retiene IGSS ni ISR')
  assert.strictEqual(aguinaldo.igss_base, 0)
  assert.strictEqual(aguinaldo.isr_base, 0, 'un aguinaldo de un sueldo está exento')
  assert.strictEqual(aguinaldo.employer_cost, 0, 'las provisiones son solo de la corrida ordinaria')
  assert.ok(!aguinaldo.lines.some((l) => l.concept === 'ANTICIPO'), 'los anticipos solo se descuentan en la ordinaria')
}

console.log('payroll-calc-selfcheck OK')
