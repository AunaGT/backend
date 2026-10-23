/**
 * Copyright (c) 2026 Diego Patzán. All Rights Reserved.
 */

const { Router } = require('express')
const multer = require('multer')
const { Auth, hasPermission } = require('../../middlewares/autenticacion')
const {
  getAll,
  getPublic,
  getCompanyName,
  getCompanyLogo,
  getDenominations,
  update,
  uploadLogo,
  removeLogo,
  history,
} = require('./controller')

const router = Router()
router.use('/document-templates', require('./documentTemplates/routes').createRouter())
router.use('/hardware/operations', require('./hardware/printing/routes'))
router.use('/hardware/operations', require('./hardware/drawer/routes'))
router.use('/hardware', require('./hardware/routes'))

const uploadLogoImage = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
})

router.get('/', Auth, hasPermission('settings.view', 'settings.manage'), getAll)
router.get('/history', Auth, hasPermission('settings.view', 'settings.manage'), history)
router.get('/public', Auth, getPublic)
router.get('/company-name', getCompanyName)
router.get('/company-logo', getCompanyLogo)
router.get('/denominations', Auth, getDenominations)
router.patch('/', Auth, hasPermission('settings.manage'), update)
router.post(
  '/upload-logo',
  Auth,
  hasPermission('settings.manage'),
  uploadLogoImage.single('image'),
  uploadLogo
)
router.delete('/logo', Auth, hasPermission('settings.manage'), removeLogo)

module.exports = router
