const {Router,json}=require('express')
const multer=require('multer')
const service=require('./service'),appearance=require('./appearance'),assets=require('./assets')
const {schemaManifest,compileTemplate,resolveBase}=require('./public')
const {authorize}=require('./permissions')
function createRouter(options={}) {
  const router=Router()
  const auth=options.auth||require('../../../middlewares/autenticacion').Auth
  const scope=options.scope||require('../hardware/controller').scope
  const database=()=>options.db||require('../../../models/prisma').prisma
  const transactionDb=()=>options.transactionDb||require('../../../models/prisma').prismaTransaction
  const handler=(run,status=200)=>async(req,res,next)=>{
    try {const s=scope(req);authorize(s);res.set('Cache-Control','private, no-store');const value=await run(req,s,res);if(!res.headersSent)res.status(status).json(value)}
    catch(error){if(error.status)return res.status(error.status).json({message:error.message,...(error.code?{code:error.code}:{}),...(error.diagnostics?{diagnostics:error.diagnostics}:{})});next(error)}
  }
  router.use(auth,json({limit:'300kb'}))
  router.get('/schema',handler(async(_r,s)=>{
    const presets=purpose=>Object.fromEntries(schemaManifest.bases.map(base=>[base,Object.fromEntries(schemaManifest.formats.map(format=>[format,resolveBase(base,format,purpose)]))]))
    const fiscal=await database().systemSetting.findFirst({where:{company_id:s.companyId,key:'fel_enabled'}})
    return {...schemaManifest,presets:presets('INTERNAL_RECEIPT'),fiscalPresets:presets('FEL_INVOICE'),fiscalEnabled:fiscal?.value==='true',defaults:{ticketFormat:'RECEIPT_80',sheetFormat:'LETTER',base:'CLASSIC'}}
  }))
  router.get('/',handler((r,s)=>service.listTemplates(database(),s,r.query)))
  router.post('/compile',handler((r,s)=>{authorize(s,'manage');return compileTemplate(r.body)}))
  router.get('/appearance',handler((r,s)=>appearance.readAppearance(database(),s)))
  router.put('/appearance',handler((r,s)=>appearance.saveAppearance(transactionDb(),s,r.body)))
  const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:5*1024*1024,files:1,fields:3}})
  router.post('/assets',upload.single('image'),handler((r,s)=>assets.uploadAsset(transactionDb(),s,{...r.body,file:r.file}),201))
  router.get('/assets/:assetId',handler(async(r,s,res)=>{const buffer=await assets.readAsset(database(),s,r.params.assetId);res.type('image/png').send(buffer)}))
  router.post('/',handler((r,s)=>service.saveDraft(transactionDb(),s,r.body),201))
  router.post('/duplicate',handler((r,s)=>service.duplicateTemplate(transactionDb(),s,r.body),201))
  router.post('/preview-jobs',handler((r,s)=>require('./previews').requestPreview(transactionDb(),s,r.body),202))
  router.get('/preview-jobs/:artifactId',handler((r,s)=>require('./previews').getPreview(database(),s,r.params.artifactId)))
  router.get('/preview-jobs/:artifactId/file',handler(async(r,s,res)=>{const file=await require('./previews').downloadPreview(database(),s,r.params.artifactId);res.type('application/pdf').attachment(file.filename).send(file.buffer)}))
  router.get('/:id',handler((r,s)=>service.getTemplate(database(),s,r.params.id)))
  router.put('/:id',handler((r,s)=>service.saveDraft(transactionDb(),s,{...r.body,id:r.params.id})))
  router.delete('/:id',handler((r,s)=>service.discardDraft(transactionDb(),s,{...r.body,id:r.params.id})))
  router.post('/:id/duplicate',handler((r,s)=>service.duplicateTemplate(transactionDb(),s,{...r.body,templateId:r.params.id}),201))
  router.post('/:id/reset',handler((r,s)=>service.resetDraft(transactionDb(),s,{...r.body,id:r.params.id})))
  router.post('/:id/publish',handler((r,s)=>service.publishTemplate(transactionDb(),s,{...r.body,id:r.params.id})))
  router.post('/:id/archive',handler((r,s)=>service.archiveTemplate(transactionDb(),s,{...r.body,id:r.params.id})))
  router.get('/:id/versions',handler((r,s)=>service.versions(database(),s,r.params.id)))
  router.get('/:id/export',handler(async(r,s,res)=>{
    const row=await service.getTemplate(database(),s,r.params.id)
    // Source references only logical image slots, never storage paths or foreign asset IDs.
    res.type('application/xml').attachment('plantilla-auna.xml').send(compileTemplate({design:row.design}).source)
  }))
  router.use((error,_req,res,next)=>{if(error.code==='LIMIT_FILE_SIZE'||error.type==='entity.too.large')return res.status(413).json({message:'El archivo supera el tamaño permitido'});if(error instanceof multer.MulterError)return res.status(400).json({message:'Carga de archivo no válida'});next(error)})
  return router
}
module.exports={createRouter}
