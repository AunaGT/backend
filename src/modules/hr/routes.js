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
const multer = require('multer')
const router = Router()
const { Auth, hasPermission } = require('../../middlewares/autenticacion')
const Employees = require('./controllers/employees')
const Attendance = require('./controllers/attendance')
const Advances = require('./controllers/advances')
const DocumentTypes = require('./controllers/documentTypes')
const Documents = require('./controllers/documents')
const EmployeeDirectory = require('./controllers/employeeDirectory')
const EmployeeHistory = require('./controllers/employeeHistory')

// Busboy emits partsLimit when it reaches the limit (not when it exceeds it).
// Reserve one extra part; files and fields still enforce the exact limits.
// File size also signals at equality: the extra byte lets an exact 5 MB file
// through while rejecting 5 MB + 1 before any controller/storage call.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 + 1, files: 1, fields: 1, fieldSize: 1024, parts: 3 } })
const documentsUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 + 1, files: 20, fields: 2, fieldSize: 64 * 1024, parts: 23 } })

function checkedUpload(middleware) {
  return (req, res, next) => middleware(req, res, error => {
    if (!error) return next()
    const messages = {
      LIMIT_FILE_SIZE: 'Cada archivo admite hasta 5 MB',
      LIMIT_FILE_COUNT: 'La carga supera la cantidad de archivos permitida',
      LIMIT_UNEXPECTED_FILE: 'El archivo no corresponde al formulario o se enviaron archivos adicionales',
      LIMIT_FIELD_COUNT: 'El formulario contiene campos adicionales; vuelve a intentar la carga',
      LIMIT_FIELD_VALUE: 'Los datos del formulario superan el tamaño permitido',
      LIMIT_FIELD_KEY: 'El nombre de un campo del formulario es demasiado largo',
      LIMIT_PART_COUNT: 'La carga contiene demasiados archivos o campos',
    }
    error.status = ['LIMIT_FILE_SIZE', 'LIMIT_FIELD_VALUE'].includes(error.code) ? 413 : 400
    error.message = messages[error.code] || 'La carga del formulario está incompleta o no es válida; vuelve a intentarlo'
    next(error)
  })
}

router.get('/document-types', Auth, DocumentTypes.list)
router.get('/employee-directory', Auth, EmployeeDirectory.list)
router.post('/document-types', Auth, hasPermission('settings.manage'), DocumentTypes.create)
router.put('/document-types/:typeId', Auth, hasPermission('settings.manage'), DocumentTypes.update)

// Empleados
router.get('/employees', Auth, hasPermission('hr.employees.view'), Employees.list)
// Antes de /employees/:id, si no 'linkable-users' se lee como un id.
router.get('/employees/linkable-users', Auth, hasPermission('hr.employees.view'), Employees.linkableUsers)
// La ficha propia no pide permiso de RRHH, y va antes de /employees/:id.
router.get('/employees/me', Auth, Employees.mine)
router.post('/employees', Auth, hasPermission('hr.employees.create'), checkedUpload(documentsUpload.any()), Employees.create)
router.get('/employees/:id', Auth, hasPermission('hr.employees.view'), Employees.getById)
router.get('/employees/:id/history', Auth, hasPermission('hr.employees.view'), EmployeeHistory.list)
router.get('/employees/:id/overview', Auth, hasPermission('hr.employees.view'), EmployeeHistory.overview)
router.put('/employees/:id', Auth, hasPermission('hr.employees.edit'), Employees.update)
router.get('/employees/:id/documents', Auth, hasPermission('hr.documents.view'), Documents.list)
router.post('/employees/:id/documents', Auth, hasPermission('hr.documents.manage'), checkedUpload(upload.single('file')), Documents.upload)
router.post('/employees/:id/documents/:documentId/access', Auth, hasPermission('hr.documents.view'), Documents.access)
router.post('/employees/:id/documents/:documentId/archive', Auth, hasPermission('hr.documents.archive'), Documents.archive)
router.post('/employees/:id/documents/:documentId/restore', Auth, hasPermission('hr.documents.archive'), Documents.restore)
router.post('/employees/:id/photo', Auth, hasPermission('hr.employees.edit'), checkedUpload(upload.single('file')), Employees.uploadPhoto)
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
