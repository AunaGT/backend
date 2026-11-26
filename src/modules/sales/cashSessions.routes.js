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
const { Auth, hasPermission } = require('../../middlewares/autenticacion')
const { listRegisters, getCurrent, openSession, closeSession, createRegister, updateRegister, setRegisterUsers, capabilities, adoptRegister, paymentOptions, getConfiguration, saveConfiguration, registerUsers } = require('./cashSessions.controller')

const router = Router()
router.post('/:id/join', Auth, hasPermission('sales.create','cashclosure.create','cashclosure.create_day','cashclosure.create_own',...require('../../services/cashSharedSessions').operationPermissions), require('./cashSessions.controller').joinSession)

const canCashSessionsApi = hasPermission(
  'sales.create',
  'cashclosure.create',
  'cashclosure.create_day',
  'cashclosure.create_own',
  'cashclosure.view'
)

const canRegisterMetadata = hasPermission('cash.registers.view', 'cash.registers.manage', 'settings.manage', 'sales.create', 'cashclosure.create', 'cashclosure.create_day', 'cashclosure.create_own', 'cashclosure.view')
router.get('/registers', Auth, canRegisterMetadata, listRegisters)
router.get('/capabilities', Auth, canRegisterMetadata, capabilities)
router.get('/register-users', Auth, hasPermission('cash.registers.manage'), registerUsers)
router.post('/registers/configuration', Auth, hasPermission('cash.registers.manage'), saveConfiguration)
router.get('/registers/:id/configuration', Auth, hasPermission('cash.registers.view', 'cash.registers.manage'), getConfiguration)
router.put('/registers/:id/configuration', Auth, hasPermission('cash.registers.manage'), saveConfiguration)
router.get('/payment-options', Auth, hasPermission('merchandise.mark_paid'), paymentOptions)
router.patch('/registers/:id/event-adoption', Auth, adoptRegister)
router.post('/registers', Auth, hasPermission('settings.manage'), createRegister)
router.patch('/registers/:id', Auth, hasPermission('settings.manage'), updateRegister)
router.put('/registers/:id/users', Auth, hasPermission('settings.manage'), setRegisterUsers)
router.get('/current', Auth, hasPermission('sales.create', 'cashclosure.create', 'cashclosure.create_day', 'cashclosure.create_own', 'cashclosure.view', ...require('../../services/cashSharedSessions').operationPermissions), getCurrent)
router.post('/open', Auth, canCashSessionsApi, openSession)
router.post('/close', Auth, canCashSessionsApi, closeSession)

module.exports = router
