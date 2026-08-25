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
const Attendance = require('../controllers/hrAttendance.controller')
const Advances = require('../controllers/hrAdvances.controller')

// Empleados
router.get('/employees', Auth, hasPermission('hr.employees.view'), Employees.list)
// Antes de /employees/:id, si no 'linkable-users' se lee como un id.
router.get('/employees/linkable-users', Auth, hasPermission('hr.employees.view'), Employees.linkableUsers)
// La ficha propia no pide permiso de RRHH, y va antes de /employees/:id.
router.get('/employees/me', Auth, Employees.mine)
router.post('/employees', Auth, hasPermission('hr.employees.create'), Employees.create)
router.get('/employees/:id', Auth, hasPermission('hr.employees.view'), Employees.getById)
router.put('/employees/:id', Auth, hasPermission('hr.employees.edit'), Employees.update)
router.delete('/employees/:id', Auth, hasPermission('hr.employees.delete'), Employees.remove)

// Asistencia
router.get('/attendance', Auth, hasPermission('hr.attendance.view'), Attendance.list)
router.post('/attendance', Auth, hasPermission('hr.attendance.manage'), Attendance.upsert)
router.post('/attendance/bulk', Auth, hasPermission('hr.attendance.manage'), Attendance.bulk)
router.delete('/attendance/:id', Auth, hasPermission('hr.attendance.manage'), Attendance.remove)

// Anticipos
router.get('/advances', Auth, hasPermission('hr.advances.view'), Advances.list)
router.post('/advances', Auth, hasPermission('hr.advances.manage'), Advances.create)
router.post('/advances/:id/cancel', Auth, hasPermission('hr.advances.manage'), Advances.cancel)

module.exports = router
