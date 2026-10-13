const { Router } = require('express')
const Quotes = require('./controller')
const { rateLimit } = require('express-rate-limit')

const router = Router()

router.get('/public/:token', Quotes.getPublicByToken)
router.post('/public/:token/respond', rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: true, legacyHeaders: false }), Quotes.respondPublic)

module.exports = router
