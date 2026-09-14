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
const { Auth, hasAnyRole, hasPermission } = require('../../middlewares/autenticacion')
const ctrl = require('./paymentTerms.controller')
const router = Router()

const canManage = hasPermission('catalogs.manage')

// GET /catalogs/payment-terms (lectura: cualquier usuario autenticado, alimenta selects)
router.get('/', Auth, ctrl.list)

// GET /catalogs/payment-terms/template
router.get('/template', Auth, canManage, ctrl.downloadTemplate)

// POST /catalogs/payment-terms/validate-import-mapped
router.post('/validate-import-mapped', Auth, hasPermission('catalogs.manage'), ctrl.validateImportMapped)

// POST /catalogs/payment-terms/bulk-import-mapped
router.post('/bulk-import-mapped', Auth, hasPermission('catalogs.manage'), ctrl.bulkImportMapped)

// POST /catalogs/payment-terms
router.post('/', Auth, canManage, ctrl.create)

// PUT /catalogs/payment-terms/:id
router.put('/:id', Auth, canManage, ctrl.update)

// DELETE /catalogs/payment-terms/:id (soft delete)
router.delete('/:id', Auth, canManage, ctrl.remove)

// PATCH /catalogs/payment-terms/:id/restore
router.patch('/:id/restore', Auth, canManage, ctrl.restore)

module.exports = router
