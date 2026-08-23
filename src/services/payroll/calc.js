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
 * Motor de cálculo de nómina guatemalteca. Funciones puras: reciben números y
 * fechas, devuelven números. Sin Prisma, sin `req`, sin reloj — por eso el
 * self-check corre sin base de datos.
 */

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100

const MS_DAY = 86400000

/** Días calendario entre dos fechas, contando ambas. 0 si `to` es anterior. */
function daysInclusive(from, to) {
  const a = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate())
  const b = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate())
  if (b < a) return 0
  return Math.round((b - a) / MS_DAY) + 1
}

/**
 * Días de mes comercial (30) que corresponden al tramo contratado dentro del
 * período. Un mes completo da 30 aunque tenga 31 o 28 días; medio período da
 * la mitad. Es proporcional a la CONTRATACIÓN, no a la asistencia: un ausente
 * cobra igual.
 */
function proratedDays({ periodStart, periodEnd, hireDate, terminationDate }) {
  const periodDays = daysInclusive(periodStart, periodEnd)
  if (periodDays === 0) return 0
  const from = hireDate > periodStart ? hireDate : periodStart
  const to = terminationDate && terminationDate < periodEnd ? terminationDate : periodEnd
  return round2((30 * daysInclusive(from, to)) / periodDays)
}

/** Importe mensual llevado a los días comerciales efectivamente contratados. */
function proratedAmount(monthlyAmount, days) {
  return round2((Number(monthlyAmount) * Number(days)) / 30)
}

/** Hora ordinaria: mes de 30 días, jornada de 8 horas. */
function hourlyRate(baseSalary) {
  return Number(baseSalary) / 30 / 8
}

function overtimePay(baseSalary, hours, factor) {
  return round2(hourlyRate(baseSalary) * Number(factor) * Number(hours))
}

/**
 * Base afecta a IGSS: sueldo ordinario + horas extra. La bonificación incentivo
 * queda FUERA (Decreto 78-89): no es salario para IGSS, indemnización,
 * aguinaldo ni bono 14.
 */
function igssBase({ ordinary, overtime }) {
  return round2(Number(ordinary) + Number(overtime))
}

function igssEmployee(base, rates) {
  return round2(Number(base) * rates.igssLaboral)
}

/** Costo patronal sobre la misma base: IGSS + IRTRA + INTECAP. */
function employerCost(base, rates) {
  const igss = round2(Number(base) * rates.igssPatronal)
  const irtra = round2(Number(base) * rates.irtra)
  const intecap = round2(Number(base) * rates.intecap)
  return { igss, irtra, intecap, total: round2(igss + irtra + intecap) }
}

/** Provisiones laborales mensuales sobre el ordinario. Costo de la empresa. */
function provisions(ordinary, rates) {
  const base = Number(ordinary)
  const aguinaldo = round2(base * rates.provisionAguinaldo)
  const bono14 = round2(base * rates.provisionBono14)
  const vacaciones = round2(base * rates.provisionVacaciones)
  const indemnizacion = round2(base * rates.provisionIndemnizacion)
  return { aguinaldo, bono14, vacaciones, indemnizacion, total: round2(aguinaldo + bono14 + vacaciones + indemnizacion) }
}

/**
 * Aguinaldo (Decreto 76-78, 1-dic → 30-nov) y bono 14 (Decreto 42-92,
 * 1-jul → 30-jun): un sueldo por año completo, proporcional si no lo es.
 */
function annualBonus({ baseSalary, periodStart, periodEnd, hireDate, terminationDate }) {
  const from = hireDate > periodStart ? hireDate : periodStart
  const to = terminationDate && terminationDate < periodEnd ? terminationDate : periodEnd
  const days = Math.min(365, daysInclusive(from, to))
  return round2((Number(baseSalary) * days) / 365)
}

/** Art. 68 Decreto 10-2012: exento hasta un sueldo ordinario mensual. */
function bonusTaxableExcess(bonusAmount, baseSalary) {
  return round2(Math.max(0, Number(bonusAmount) - Number(baseSalary)))
}

/** ISR anual por tramos (Decreto 10-2012 art. 173). */
function annualIsr(taxable, rates) {
  const base = Math.max(0, Number(taxable))
  const tax = base <= rates.isrTramo1Limite
    ? base * rates.isrTramo1Tasa
    : rates.isrTramo2Fijo + (base - rates.isrTramo1Limite) * rates.isrTramo2Tasa
  return round2(tax)
}

/**
 * Retención del mes por proyección anual autocorrectiva: si a mitad de año
 * cambia el sueldo, el diferencial se reparte entre los meses que faltan y no
 * hace falta un ajuste manual de fin de año.
 *
 * `month` es 1-12 e incluye el mes que se está calculando.
 */
function isrWithholding({ month, taxableYTD, igssYTD, isrWithheldYTD, monthlyTaxable, monthlyIgss }, rates) {
  const remaining = 12 - Number(month) + 1
  if (remaining <= 0) return 0
  const projectedGross = Number(taxableYTD) + remaining * Number(monthlyTaxable)
  const projectedIgss = Number(igssYTD) + remaining * Number(monthlyIgss)
  const taxable = Math.max(0, projectedGross - rates.isrDeduccionUnica - projectedIgss)
  const annual = annualIsr(taxable, rates)
  return round2(Math.max(0, (annual - Number(isrWithheldYTD)) / remaining))
}

module.exports = {
  round2, daysInclusive, proratedDays, proratedAmount, hourlyRate, overtimePay,
  igssBase, igssEmployee, employerCost, provisions, annualBonus, bonusTaxableExcess,
  annualIsr, isrWithholding,
}
