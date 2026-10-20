const {Router}=require('express'),{Auth}=require('../../../../middlewares/autenticacion'),{prismaTransaction}=require('../../../../models/prisma'),{handler}=require('../controller'),s=require('./intents')
const router=Router();router.use(Auth)
router.get('/drawer-intents',handler((r,scope)=>s.listIntents(prismaTransaction,scope,r.query)))
router.post('/drawer-intents/claim',handler((r,scope)=>s.claimIntent(prismaTransaction,scope,r.body)))
router.post('/drawer-intents/:id/result',handler((r,scope)=>s.recordResult(prismaTransaction,scope,r.params.id,r.body)))
module.exports=router
