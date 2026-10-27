const {Router}=require('express')
const {createPackageHandlers,requestScope}=require('./controller')
const multer=require('multer')
const {assertPackageWriteAccess}=require('./catalog')
const {MAX_IMAGE_BYTES,storePackageImage}=require('./images')
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:MAX_IMAGE_BYTES,files:1,fields:0,parts:2}}).single('image')
function createPackageRouter(options={}) {
  const router=Router(),handlers=createPackageHandlers(options)
  router.use(options.auth??require('../../../middlewares/autenticacion').Auth)
  router.use((_req,res,next)=>{res.set('Cache-Control','no-store');next()})
  router.post('/images',async(req,res,next)=>{
    try{
      const scope=(options.scope??requestScope)(req),db=options.db??require('../../../models/prisma').prisma
      await assertPackageWriteAccess(db,scope)
      upload(req,res,error=>{
        if(error)return res.status(error.code==='LIMIT_FILE_SIZE'?413:400).json({code:'PACKAGE_IMAGE_INVALID',message:error.code==='LIMIT_FILE_SIZE'?'La imagen admite hasta 5 MB':'Selecciona solo una imagen JPG, PNG o WebP'})
        void storePackageImage(scope.companyId,req.file,{storage:options.storage}).then(result=>res.status(201).json(result)).catch(error=>{
          if(error.status)return res.status(error.status).json({code:error.code,message:error.message})
          next(error)
        })
      })
    }catch(error){if(error.status)return res.status(error.status).json({code:error.code,message:error.message});next(error)}
  })
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
