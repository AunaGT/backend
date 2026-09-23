const { Router } = require('express')
const Orders = require('./controller')

const router = Router()

router.get('/public/:token', Orders.getPublicByToken)

module.exports = router
