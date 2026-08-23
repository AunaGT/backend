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
 * Tasas de nómina. Ninguna vive hardcodeada en el motor: cuando el Congreso
 * mueva un porcentaje se cambia en Configuración, no en el código.
 */

const PAYROLL_RATES_KEY = 'payroll.rates'

const DEFAULT_RATES = {
  igssLaboral: 0.0483,      // cuota del trabajador
  igssPatronal: 0.1067,     // cuota del patrono
  irtra: 0.01,
  intecap: 0.01,
  bonificacionIncentivo: 250, // Decreto 78-89
  isrDeduccionUnica: 48000,   // anual, sin comprobación
  isrTramo1Limite: 300000,
  isrTramo1Tasa: 0.05,
  isrTramo2Fijo: 15000,
  isrTramo2Tasa: 0.07,
  horaExtraFactor: 1.5,       // Art. 121 Código de Trabajo
  provisionAguinaldo: 0.0833,
  provisionBono14: 0.0833,
  provisionVacaciones: 0.0417,
  provisionIndemnizacion: 0.0972,
}

/**
 * Lee `payroll.rates` de SystemSetting y lo mezcla con los defaults. Una clave
 * ausente, no numérica o negativa se ignora: es preferible calcular con el
 * default legal que reventar la planilla por un JSON mal editado.
 */
async function getPayrollRates(db, companyId) {
  const row = await db.systemSetting.findUnique({
    where: { company_id_key: { company_id: companyId, key: PAYROLL_RATES_KEY } },
  })
  if (!row) return { ...DEFAULT_RATES }
  let parsed
  try { parsed = JSON.parse(row.value) } catch { return { ...DEFAULT_RATES } }
  const rates = { ...DEFAULT_RATES }
  for (const key of Object.keys(DEFAULT_RATES)) {
    const n = Number(parsed?.[key])
    if (Number.isFinite(n) && n >= 0) rates[key] = n
  }
  return rates
}

module.exports = { PAYROLL_RATES_KEY, DEFAULT_RATES, getPayrollRates }
