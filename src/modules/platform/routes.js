const { Router } = require('express')
const { Auth, hasPermission } = require('../../middlewares/autenticacion')
const { readCompanyModules, updateCompanyModule } = require('./service')

const router = Router()

router.get('/', Auth, async (req, res, next) => {
  try {
    if (!req.companyId) return res.status(400).json({ message: 'Selecciona una empresa' })
    const modules = await readCompanyModules(req.companyId)
    res.json({ modules })
  } catch (error) {
    next(error)
  }
})

router.patch('/:code', Auth, hasPermission('settings.manage'), async (req, res, next) => {
  try {
    if (!req.companyId) return res.status(400).json({ message: 'Selecciona una empresa' })
    const modules = await updateCompanyModule(req.companyId, req.params.code, req.body || {})
    res.json({ modules })
  } catch (error) {
    next(error)
  }
})

module.exports = router
