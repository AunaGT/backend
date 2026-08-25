/**
 * Copyright (c) 2026 Diego Patzán. All Rights Reserved.
 *
 * This source code is licensed under a Proprietary License.
 * Unauthorized copying, modification, distribution, or use of this file,
 * via any medium, is strictly prohibited without express written permission.
 *
 * For licensing inquiries: GitHub @dpatzan2
 */

const { Router } = require('express')
const router = Router()
const { Auth, hasPermission } = require('../middlewares/autenticacion')
const Payroll = require('../controllers/payroll.controller')

router.get('/runs', Auth, hasPermission('payroll.view'), Payroll.list)
router.post('/runs', Auth, hasPermission('payroll.create'), Payroll.create)
router.get('/runs/:id', Auth, hasPermission('payroll.view'), Payroll.getById)
router.post('/runs/:id/recalculate', Auth, hasPermission('payroll.create'), Payroll.recalculate)
router.delete('/runs/:id', Auth, hasPermission('payroll.create'), Payroll.remove)
router.get('/runs/:id/payslips/:payslipId', Auth, hasPermission('payroll.view'), Payroll.getPayslip)

const Transitions = require('../controllers/payrollTransitions.controller')
router.post('/runs/:id/confirm', Auth, hasPermission('payroll.confirm'), Transitions.confirm)
router.post('/runs/:id/pay', Auth, hasPermission('payroll.pay'), Transitions.pay)
router.post('/runs/:id/cancel', Auth, hasPermission('payroll.cancel'), Transitions.cancel)

module.exports = router
