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
const { Auth, hasPermission } = require('../../middlewares/autenticacion')
const Warehouses = require('./warehouses.controller')

// Leer la lista es saber cómo se llaman los anaqueles: lo necesita cualquiera
// que filtre inventario, reciba un traslado o cuente. Gestionarlos sí es aparte.
const canView = hasPermission(
  'warehouses.view', 'warehouses.manage', 'products.view', 'stock_moves.view', 'stock_moves.create'
)
const canManage = hasPermission('warehouses.manage')

router.get('/', Auth, canView, Warehouses.list)
router.post('/', Auth, canManage, Warehouses.create)
// Las rutas de ubicación van antes de /:id para que "locations" no se lea como un id.
router.put('/locations/:locationId/sales', Auth, canManage, Warehouses.setSalesLocation)
router.patch('/locations/:locationId', Auth, canManage, Warehouses.updateLocation)
router.delete('/locations/:locationId', Auth, canManage, Warehouses.removeLocation)
router.post('/:id/locations', Auth, canManage, Warehouses.createLocation)
router.patch('/:id', Auth, canManage, Warehouses.update)
router.delete('/:id', Auth, canManage, Warehouses.remove)

module.exports = router
