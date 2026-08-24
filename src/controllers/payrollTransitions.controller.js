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
 * Transiciones de una planilla:
 *
 *   BORRADOR ──confirm──> CONFIRMADA ──pay──> PAGADA
 *       │                      │
 *       └────── cancel ────────┴──> ANULADA
 *
 * Desde PAGADA no se anula: la corrección es una planilla de ajuste.
 *
 * Cada transición arranca con un reclamo atómico (`updateMany` filtrando por el
 * estado esperado, y `count === 1`), el mismo patrón de cashSessions y de la
 * recepción de traslados. Sin él, dos confirmaciones simultáneas descontarían
 * el anticipo dos veces y postearían dos asientos.
 */

const { prismaTransaction } = require('../models/prisma')
const { requireCompany } = require('../middlewares/tenant')
const { fail, toUuid } = require('./hrEmployees.controller')
const { RUN_INCLUDE, TX_OPTIONS } = require('./payroll.controller')

/** Lee la corrida de la empresa del request o falla con 404. */
async function loadRun(tx, req) {
  const companyId = requireCompany(req)
  const id = toUuid(req.params.id, 'Planilla no encontrada')
  const run = await tx.payrollRun.findFirst({
    where: { id, company_id: companyId },
    include: { payslips: { include: { lines: true } } },
  })
  if (!run) fail(404, 'Planilla no encontrada')
  return run
}

/** POST /api/payroll/runs/:id/confirm */
exports.confirm = async (req, res, next) => {
  try {
    const updated = await prismaTransaction.$transaction(async (tx) => {
      const run = await loadRun(tx, req)
      if (run.status === 'CONFIRMADA' || run.status === 'PAGADA') fail(409, 'La planilla ya fue confirmada')
      if (run.status === 'ANULADA') fail(409, 'La planilla está anulada')

      const claim = await tx.payrollRun.updateMany({
        where: { id: run.id, status: 'BORRADOR' },
        data: { status: 'CONFIRMADA', confirmed_by: req.user?.sub || null, confirmed_at: new Date() },
      })
      if (claim.count !== 1) fail(409, 'La planilla ya fue confirmada')

      // Descontar las cuotas de anticipo por el importe EXACTO de la línea.
      for (const slip of run.payslips) {
        for (const line of slip.lines) {
          if (line.concept !== 'ANTICIPO' || !line.advance_id) continue
          // Reclamo atómico también sobre el anticipo: el importe quedó congelado al
          // generar el borrador, y entre eso y ahora otra planilla pudo descontar su
          // cuota o RRHH pudo cancelar el anticipo. Sin el `gte` el saldo se iría a
          // negativo y el clamp de abajo lo taparía cobrándole dos veces al empleado.
          const claim = await tx.employeeAdvance.updateMany({
            where: { id: line.advance_id, status: 'PENDIENTE', balance: { gte: line.amount } },
            data: { balance: { decrement: line.amount } },
          })
          if (claim.count !== 1) {
            fail(409, 'El anticipo cambió desde que se generó la planilla; recalcula la planilla antes de confirmarla')
          }
          // El saldo ya no puede quedar negativo: solo hay que marcar el que llegó a cero.
          await tx.employeeAdvance.updateMany({
            where: { id: line.advance_id, balance: 0, status: 'PENDIENTE' },
            data: { status: 'PAGADO' },
          })
        }
      }

      // fase 3: await postPayrollRun(tx, { run, userId: req.user?.sub })

      return tx.payrollRun.findUnique({ where: { id: run.id }, include: RUN_INCLUDE })
    }, TX_OPTIONS)

    res.json(updated)
  } catch (e) { next(e) }
}

/** POST /api/payroll/runs/:id/pay */
exports.pay = async (req, res, next) => {
  try {
    const updated = await prismaTransaction.$transaction(async (tx) => {
      const run = await loadRun(tx, req)
      if (run.status === 'BORRADOR') fail(409, 'La planilla debe confirmarse antes de pagarse')
      if (run.status === 'ANULADA') fail(409, 'La planilla está anulada')
      if (run.status === 'PAGADA') fail(409, 'La planilla ya fue pagada')

      const claim = await tx.payrollRun.updateMany({
        where: { id: run.id, status: 'CONFIRMADA' },
        data: { status: 'PAGADA', paid_at: new Date() },
      })
      if (claim.count !== 1) fail(409, 'La planilla ya fue pagada')

      // fase 3: await postPayrollPayment(tx, { run, userId: req.user?.sub })

      return tx.payrollRun.findUnique({ where: { id: run.id }, include: RUN_INCLUDE })
    }, TX_OPTIONS)

    res.json(updated)
  } catch (e) { next(e) }
}

/** POST /api/payroll/runs/:id/cancel */
exports.cancel = async (req, res, next) => {
  try {
    const updated = await prismaTransaction.$transaction(async (tx) => {
      const run = await loadRun(tx, req)
      if (run.status === 'PAGADA') fail(409, 'Una planilla pagada no se puede anular')
      if (run.status === 'ANULADA') fail(409, 'La planilla ya fue anulada')

      const estabaConfirmada = run.status === 'CONFIRMADA'
      const claim = await tx.payrollRun.updateMany({
        where: { id: run.id, status: run.status },
        data: { status: 'ANULADA', cancelled_by: req.user?.sub || null, cancelled_at: new Date() },
      })
      if (claim.count !== 1) fail(409, 'La planilla cambió de estado, recarga la página')

      if (estabaConfirmada) {
        // Restituir el saldo con el importe EXACTO que se descontó, no con uno
        // recalculado: las tasas o la cuota pudieron cambiar desde entonces.
        for (const slip of run.payslips) {
          for (const line of slip.lines) {
            if (line.concept !== 'ANTICIPO' || !line.advance_id) continue
            await tx.employeeAdvance.update({
              where: { id: line.advance_id },
              data: { balance: { increment: line.amount }, status: 'PENDIENTE' },
            })
          }
        }
        // fase 3: await reversePayrollRun(tx, { run, userId: req.user?.sub })
      }

      return tx.payrollRun.findUnique({ where: { id: run.id }, include: RUN_INCLUDE })
    }, TX_OPTIONS)

    res.json(updated)
  } catch (e) { next(e) }
}
