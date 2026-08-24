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
 * Anticipos de sueldo. El `balance` lo baja la planilla al confirmarse y lo
 * restituye al anularse; aquí solo se otorgan y se cancelan.
 *
 * Cancelar solo se permite mientras ninguna planilla haya descontado cuota
 * (`balance == amount`): después ya hay un recibo que lo referencia y la
 * corrección es anular esa planilla, no el anticipo.
 */

const { prisma, prismaTransaction } = require('../models/prisma')
const { requireCompany, targetBranch, branchWhere } = require('../middlewares/tenant')
const { fail, toDate, toMoney, trim, toEnum } = require('./hrEmployees.controller')
const { postAdvance, reverseAdvance } = require('../services/payroll/posting')

const ADVANCE_STATUSES = ['PENDIENTE', 'PAGADO', 'CANCELADO']

const ADVANCE_INCLUDE = {
  employee: { select: { id: true, code: true, first_name: true, last_name: true } },
  createdBy: { select: { id: true, name: true } },
}

const TX_OPTIONS = { maxWait: 10000, timeout: 20000 }

/** GET /api/hr/advances?employee_id=&status= */
exports.list = async (req, res, next) => {
  try {
    const companyId = requireCompany(req)
    const { employee_id, status } = req.query || {}
    const where = { company_id: companyId, ...branchWhere(req) }
    if (employee_id) where.employee_id = String(employee_id)
    if (status) where.status = toEnum(status, ADVANCE_STATUSES, 'El estado del anticipo no es válido')

    const items = await prisma.employeeAdvance.findMany({
      where,
      include: ADVANCE_INCLUDE,
      orderBy: { date: 'desc' },
      take: 1000,
    })
    res.json({ items })
  } catch (e) { next(e) }
}

/** POST /api/hr/advances */
exports.create = async (req, res, next) => {
  try {
    const companyId = requireCompany(req)
    const b = req.body || {}
    const employee = await prisma.employee.findFirst({
      where: { id: String(b.employee_id || ''), company_id: companyId },
      select: { id: true, branch_id: true, status: true },
    })
    if (!employee) fail(404, 'Empleado no encontrado')
    if (employee.status === 'BAJA') fail(400, 'No se puede otorgar un anticipo a un empleado dado de baja')

    const amount = toMoney(b.amount, 'El monto del anticipo', { required: true })
    if (amount <= 0) fail(400, 'El monto del anticipo debe ser mayor que cero')
    const installment = toMoney(b.installment, 'La cuota', { required: true })
    if (installment <= 0) fail(400, 'La cuota debe ser mayor que cero')
    if (installment > amount) fail(400, 'La cuota no puede ser mayor que el monto del anticipo')

    const branchId = targetBranch(req, b.branch_id || employee.branch_id)

    const created = await prismaTransaction.$transaction(async (tx) => {
      const advance = await tx.employeeAdvance.create({
        data: {
          company_id: companyId,
          branch_id: branchId,
          employee_id: employee.id,
          date: toDate(b.date, 'La fecha') || new Date(),
          amount,
          installment,
          balance: amount,
          reason: trim(b.reason, 1000),
          created_by: req.user?.sub || null,
        },
        include: ADVANCE_INCLUDE,
      })
      await postAdvance(tx, { advance, userId: req.user?.sub })
      return advance
    }, TX_OPTIONS)

    res.status(201).json(created)
  } catch (e) { next(e) }
}

/** POST /api/hr/advances/:id/cancel */
exports.cancel = async (req, res, next) => {
  try {
    const companyId = requireCompany(req)
    const current = await prisma.employeeAdvance.findFirst({ where: { id: req.params.id, company_id: companyId } })
    if (!current) fail(404, 'Anticipo no encontrado')
    if (current.status !== 'PENDIENTE') fail(409, 'Solo se puede cancelar un anticipo pendiente')
    if (Number(current.balance) !== Number(current.amount)) {
      fail(409, 'El anticipo ya tiene cuotas descontadas; anula la planilla que las descontó')
    }

    const updated = await prismaTransaction.$transaction(async (tx) => {
      // Reclamo atómico: dos cancelaciones simultáneas no deben revertir dos veces, y
      // el saldo entra al where para que el reclamo también falle si una planilla
      // descontó una cuota entre la lectura de arriba y este commit.
      const claim = await tx.employeeAdvance.updateMany({
        where: { id: current.id, status: 'PENDIENTE', balance: current.balance },
        data: { status: 'CANCELADO', balance: 0 },
      })
      if (claim.count !== 1) fail(409, 'El anticipo cambió antes de completarse la cancelación, intenta de nuevo')
      await reverseAdvance(tx, { advance: current, userId: req.user?.sub })
      return tx.employeeAdvance.findUnique({ where: { id: current.id }, include: ADVANCE_INCLUDE })
    }, TX_OPTIONS)

    res.json(updated)
  } catch (e) { next(e) }
}
