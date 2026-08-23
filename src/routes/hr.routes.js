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
const Employees = require('../controllers/hrEmployees.controller')

// Empleados
router.get('/employees', Auth, hasPermission('hr.employees.view'), Employees.list)
router.post('/employees', Auth, hasPermission('hr.employees.create'), Employees.create)
router.get('/employees/:id', Auth, hasPermission('hr.employees.view'), Employees.getById)
router.put('/employees/:id', Auth, hasPermission('hr.employees.edit'), Employees.update)
router.delete('/employees/:id', Auth, hasPermission('hr.employees.delete'), Employees.remove)

module.exports = router
