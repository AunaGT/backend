const { Router } = require('express')
const Quotes = require('../controllers/quotes.controller')

const router = Router()

router.get('/public/:token', Quotes.getPublicByToken)

module.exports = router
