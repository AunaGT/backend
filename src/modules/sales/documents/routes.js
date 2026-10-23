const {Router}=require('express')
const {Auth}=require('../../../middlewares/autenticacion')
const {scope}=require('../../config/hardware/controller')
const {prisma,prismaTransaction}=require('../../../models/prisma')
const service=require('./artifacts')
const router=Router({mergeParams:true})
router.use(Auth,(_req,res,next)=>{res.set('Cache-Control','private, no-store');next()})
const handler=run=>async(req,res,next)=>{try{await run(req,res,scope(req))}catch(e){if(e.status)return res.status(e.status).json({message:e.message,...(e.code?{code:e.code}:{})});next(e)}}
router.post('/',handler(async(r,res,s)=>{const result=await service.requestArtifact(prismaTransaction,s,{...r.body,saleId:r.params.id});res.status(result.state==='READY'?200:202).json(result)}))
router.get('/:artifactId',handler(async(r,res,s)=>res.json(await service.getArtifact(prisma,s,{saleId:r.params.id,artifactId:r.params.artifactId}))))
router.get('/:artifactId/file',handler(async(r,res,s)=>{const result=await service.downloadArtifact(prisma,s,{saleId:r.params.id,artifactId:r.params.artifactId});res.type('application/pdf').attachment(result.filename).send(result.buffer)}))
router.post('/:artifactId/retry',handler(async(r,res,s)=>res.json(await service.retryArtifact(prismaTransaction,s,{...r.body,saleId:r.params.id,artifactId:r.params.artifactId}))))
module.exports=router
