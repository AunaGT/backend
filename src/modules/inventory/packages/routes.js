const {Router}=require('express')
const {createPackageHandlers}=require('./controller')
function createPackageRouter(options={}) {
  const router=Router(),handlers=createPackageHandlers(options)
  router.use(options.auth??require('../../../middlewares/autenticacion').Auth)
  router.use((_req,res,next)=>{res.set('Cache-Control','no-store');next()})
  router.get('/',handlers.list)
  router.get('/:id',handlers.detail)
  router.post('/',handlers.create)
  router.put('/:id',handlers.save)
  router.post('/:id/activate',handlers.activate)
  router.post('/:id/archive',handlers.archive)
  return router
}
module.exports=createPackageRouter()
module.exports.createPackageRouter=createPackageRouter
