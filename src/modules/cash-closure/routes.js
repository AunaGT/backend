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
const {
  calculateTheoretical,
  create,
  list,
  getById,
  validate,
  getLastClosureDate,
  validateStocks,
  updateStatus
} = require('./controller')

const router = Router()
const disputes=require('./disputes.controller')
router.get('/disputes/capabilities',Auth,disputes.capabilities)
router.get('/disputes/origins/:eventId',Auth,disputes.origin)
router.get('/disputes',Auth,disputes.list)
router.post('/disputes',Auth,disputes.create)
router.get('/disputes/:caseId',Auth,disputes.detail)
router.post('/disputes/:caseId/preview',Auth,disputes.preview)
router.post('/disputes/:caseId/proposals',Auth,disputes.propose)
router.post('/disputes/:caseId/proposals/:proposalId/decide',Auth,disputes.decide)
router.post('/disputes/:caseId/effects',Auth,disputes.confirmEffect)
router.post('/disputes/:caseId/posting-preview',Auth,disputes.postingPreview)
router.post('/disputes/:caseId/legacy-deductions',Auth,disputes.legacyDeduction)
router.post('/disputes/:caseId/post',Auth,disputes.post)
// Un archivo y su clave de intento; el límite y la validación de tipo viven en la evidencia de caja.
const disputeUpload=require('multer')({storage:require('multer').memoryStorage(),limits:{fileSize:5*1024*1024+1,files:1,fields:1,parts:2}})
router.post('/disputes/:caseId/evidence',Auth,(req,res,next)=>disputeUpload.single('file')(req,res,e=>e?res.status(e.code==='LIMIT_FILE_SIZE'?413:400).json({message:e.code==='LIMIT_FILE_SIZE'?'El archivo supera 5 MB':'Envía un solo archivo de soporte'}):next()),disputes.attachEvidence)
router.get('/disputes/:caseId/evidence/:evidenceId',Auth,disputes.evidence)
router.get('/read-capabilities', Auth, (req,res,next) => {
  try { res.set('Cache-Control','private, no-store'); res.json(require('./readAccess').readCapabilities(req)) } catch (error) { next(error) }
})
const canReadClosure = hasPermission('cashclosure.view','cashclosure.view_team','cashclosure.approve','cashclosure.validate','cashclosure.correct')
router.get('/my-turns',Auth,require('./myTurns.controller').view)

// Cualquier permiso de crear cierre permite calcular y crear (el controlador valida día vs propio)
const canCreateAny = hasPermission('cashclosure.create', 'cashclosure.create_day', 'cashclosure.create_own')
const physical = require('./physicalMovements.controller')
const viewMovements = hasPermission('cash.movements.view_own','cash.movements.view_team')
router.get('/physical-movements/capabilities',Auth,physical.capabilities)
router.get('/physical-movements/options',Auth,hasPermission('cash.movements.create_own','cash.movements.create_team','cash.movements.correct'),physical.options)
router.get('/physical-movements',Auth,viewMovements,physical.list)
router.get('/physical-movements/:movementId',Auth,viewMovements,physical.detail)
router.post('/physical-movements',Auth,hasPermission('cash.movements.create_own','cash.movements.create_team'),physical.create)
router.post('/physical-movements/:movementId/correct',Auth,hasPermission('cash.movements.correct'),physical.correct)

// 3B.2 custodia y traslados (rutas estáticas antes de /:id de cierres)
const custody = require('./custody.controller')
const custodyAny = hasPermission('cash.custody.view','cash.custody.manage','cash.transfers.operate_own','cash.transfers.operate_team','cash.transfers.receive')
router.get('/custody/capabilities',Auth,custody.capabilities)
router.get('/custody/custodies',Auth,custodyAny,custody.custodies)
router.post('/custody/custodies',Auth,hasPermission('cash.custody.manage'),custody.createCustody)
router.patch('/custody/custodies/:custodyId',Auth,hasPermission('cash.custody.manage'),custody.updateCustody)
router.get('/custody/destinations',Auth,custodyAny,custody.destinations)
router.get('/custody/transfers',Auth,custodyAny,custody.transfers)
router.get('/custody/transfers/:transferId',Auth,custodyAny,custody.transfer)
router.post('/custody/transfers',Auth,hasPermission('cash.transfers.operate_own','cash.transfers.operate_team'),custody.send)
router.post('/custody/transfers/:transferId/receive',Auth,hasPermission('cash.transfers.receive'),custody.receive)
router.post('/custody/transfers/:transferId/reject',Auth,hasPermission('cash.transfers.receive'),custody.reject)
router.get('/custody/handovers/pending',Auth,custodyAny,custody.pendingHandovers)
router.get('/custody/sessions/:sessionId/handover',Auth,custodyAny,custody.handoverContext)
router.post('/custody/sessions/:sessionId/handover',Auth,hasPermission('cash.transfers.operate_own','cash.transfers.operate_team'),custody.handover)
router.get('/custody/registers/:registerId/float',Auth,hasPermission('sales.create','cashclosure.create','cashclosure.create_day','cashclosure.create_own','cash.custody.view'),custody.registerFloat)

// 5 cierre del día por sucursal y fecha operativa (rutas estáticas antes de /:id)
const daily = require('./dailyConsolidation.controller')
router.get('/days/:date',Auth,hasPermission('cash.day.close','cashclosure.approve','cashclosure.validate'),daily.view)
router.post('/days/:date/finalize',Auth,hasPermission('cash.day.close'),daily.finalize)

// 4B medios bancarios, depósitos y liquidaciones (rutas estáticas antes de /:id)
const settlements = require('./settlements.controller')
const canSettle = hasPermission('cash.settlements.manage')
router.get('/settlements/capabilities',Auth,settlements.capabilities)
router.get('/bank-methods',Auth,hasPermission('cash.bank_methods.manage','cash.settlements.manage'),settlements.methods)
router.get('/bank-methods/accounts',Auth,hasPermission('cash.bank_methods.manage','cash.settlements.manage'),settlements.accounts)
router.post('/bank-methods',Auth,hasPermission('cash.bank_methods.manage'),settlements.propose)
router.post('/bank-methods/:versionId/approve',Auth,settlements.approve)
router.post('/bank-methods/:versionId/reject',Auth,settlements.reject)
router.post('/bank-methods/:versionId/withdraw',Auth,hasPermission('cash.bank_methods.manage'),settlements.withdraw)
router.get('/settlements/pending',Auth,canSettle,settlements.pending)
router.get('/settlements/deposits/lookup',Auth,canSettle,settlements.deposit)
router.get('/settlements/deposits/:depositId',Auth,canSettle,settlements.deposit)
router.get('/settlements',Auth,canSettle,settlements.list)
router.post('/settlements',Auth,canSettle,settlements.create)
router.get('/settlements/:settlementId',Auth,canSettle,settlements.detail)
router.post('/settlements/:settlementId/void',Auth,canSettle,settlements.void)

// 4A avisos de pago y confirmación en caja virtual (rutas estáticas antes de /:id)
const notices = require('./notices.controller')
const noticeUpload = require('multer')({ storage: require('multer').memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 + 1, files: 1, fields: 0, parts: 1 } })
const noticeAny = hasPermission('cash.notices.create','cash.digital.confirm'), noticeConfirm = hasPermission('cash.digital.confirm')
router.get('/notices/capabilities',Auth,notices.capabilities)
router.get('/notices/periods',Auth,noticeConfirm,notices.periods)
router.post('/notices/evidence',Auth,noticeConfirm,(req,res,next)=>noticeUpload.single('file')(req,res,e=>e?res.status(e.code==='LIMIT_FILE_SIZE'?413:400).json({message:e.code==='LIMIT_FILE_SIZE'?'La evidencia admite hasta 5 MB':'Envía un solo archivo de evidencia'}):next()),notices.uploadEvidence)
router.get('/notices',Auth,noticeAny,notices.list)
router.post('/notices',Auth,hasPermission('cash.notices.create'),notices.create)
router.get('/notices/:noticeId',Auth,noticeAny,notices.detail)
router.get('/notices/:noticeId/evidence',Auth,noticeConfirm,notices.evidence)
router.post('/notices/:noticeId/confirm',Auth,noticeConfirm,notices.confirm)
router.post('/notices/:noticeId/reject',Auth,noticeConfirm,notices.reject)

// 3C revisión con política (rutas estáticas antes de /:id)
const reviewHttp = require('./reviewFlow.controller')
router.get('/review/capabilities',Auth,reviewHttp.capabilities)
router.get('/review/policy',Auth,hasPermission('cash.policies.manage','cashclosure.approve','cashclosure.validate'),reviewHttp.policy)
router.put('/review/policy',Auth,hasPermission('cash.policies.manage'),reviewHttp.savePolicy)
router.get('/review/sessions/:sessionId/state',Auth,reviewHttp.sessionState)
router.get('/:id/review',Auth,reviewHttp.review)
router.post('/:id/recount',Auth,hasPermission('cashclosure.approve','cashclosure.validate'),reviewHttp.recount)
router.post('/:id/finalize',Auth,hasPermission('cashclosure.approve','cashclosure.validate'),reviewHttp.finalize)

// Validar stocks antes de permitir cierre
router.get('/validate-stocks', Auth, validateStocks)

// Calcular cierre teórico (Auth + al menos un permiso de crear; el controller valida tipo)
router.get('/calculate-theoretical', Auth, canCreateAny, calculateTheoretical)

// Obtener fecha del último cierre (cualquiera con acceso a cierres)
router.get('/last-closure-date', Auth, hasPermission('cashclosure.view','cashclosure.view_team','cashclosure.approve','cashclosure.validate', 'cashclosure.create', 'cashclosure.create_day', 'cashclosure.create_own'), getLastClosureDate)

const corrections = require('./corrections.controller')
router.get('/:id/corrections/context',Auth,corrections.context)
router.get('/:id/corrections',Auth,corrections.list)
router.post('/:id/corrections/preview',Auth,corrections.preview)
router.post('/:id/corrections',Auth,corrections.propose)
router.get('/:id/corrections/:correctionId',Auth,corrections.detail)
router.post('/:id/corrections/:correctionId/decide',Auth,corrections.decide)
router.post('/:id/corrections/:correctionId/cancel',Auth,corrections.cancel)

// CRUD
router.get('/', Auth, canReadClosure, list)
router.get('/:id', Auth, canReadClosure, getById)
router.post('/', Auth, canCreateAny, create)

// Validar cierre (firma supervisor)
router.patch('/:id/validate', Auth, hasPermission('cashclosure.validate'), validate)

// Actualizar estado del cierre (Aprobar/Rechazar)
router.patch('/:id/status', Auth, hasPermission('cashclosure.approve', 'cashclosure.validate'), updateStatus)

module.exports = router
