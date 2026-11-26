const {Router,json}=require('express')
const {rateLimit}=require('express-rate-limit')
const {randomUUID}=require('node:crypto')
const {authenticateIntegration,validateContextHeaders}=require('./auth')
const {consumeQuota}=require('./limits')
const {recordUsage}=require('./audit')
const {fail,object}=require('./credentials')
const {publicError,preAuthKey}=require('./httpBoundary')
const catalog=require('./catalog'),management=require('./management')
const {createIntegrationDraft}=require('./drafts')
const {mutateIntegrationDraft}=require('./draftMutations')
const documents=require('./documents')
const {getUsageSummary}=require('./usage')
const database=options=>options.db||require('../../models/prisma').prismaTransaction
function createExternalRouter(options={}){
 const router=Router(),clock=options.now||(()=>new Date())
 const parseBody=json({limit:'64kb',inflate:false})
 router.use(rateLimit({windowMs:60000,limit:300,keyGenerator:preAuthKey,standardHeaders:true,legacyHeaders:false,handler:(_r,res)=>publicError(res,{integrationCode:'RATE_LIMIT'},randomUUID())}))
 router.use(async(req,res)=>{
  const requestId=req.integrationRequestId||randomUUID(),db=database(options),now=clock();let context,route='unmatched',result,error,status=200,transactionAudited=false,branchId=null
  try{
   context=await authenticateIntegration(db,req.get('Authorization'),now)
   await (options.consumeQuota||consumeQuota)(db,context,now)
   const commercial=/^\/(quotes|orders)(?:\/([^/]+)(?:\/(cancel))?)?\/?$/.exec(req.path),type=commercial?.[1]==='quotes'?'QUOTE':'ORDER'
   if(commercial){
    const isCancel=!!commercial[3],isDetail=!!commercial[2],isMutation=isCancel||req.method==='PATCH'
    route='/'+commercial[1]+(isDetail?'/:id':'')+(isCancel?'/cancel':'')
    const methods=isCancel?['POST']:isDetail?['GET','PATCH']:['GET','POST'];res.set('Allow',methods.join(', '))
    if(!methods.includes(req.method))fail(405,'METHOD_NOT_ALLOWED')
    const needed=commercial[1]+(isCancel?'.cancel_draft':req.method==='PATCH'?'.update_draft':req.method==='POST'?'.create_draft':'.read')
    if(!context.scopes.includes(needed))fail(403,'FORBIDDEN')
    if(isMutation&&!context.scopes.includes(commercial[1]+'.read'))fail(403,'FORBIDDEN')
    validateContextHeaders(req,context)
    if(req.method==='POST'||req.method==='PATCH'){
     if(Object.keys(req.query).length)fail(400)
     if(!req.is('application/json'))fail(415,'UNSUPPORTED_BODY')
     await new Promise((resolve,reject)=>parseBody(req,res,e=>e?reject(Object.assign(Error('body'),{integrationCode:e.type==='entity.too.large'?'BODY_TOO_LARGE':e.status===415?'UNSUPPORTED_BODY':'INVALID_INPUT'})):resolve()))
     if(isMutation){
      const out=await mutateIntegrationDraft(db,context,type,commercial[2],isCancel?'CANCEL_DRAFT':'UPDATE_DRAFT',req.body,req.get('Idempotency-Key'),req.get('If-Match'),{now,requestId,requestedBranchId:req.get('X-Branch-Id')??null})
      transactionAudited=true;result=out.receipt;status=200;branchId=result.branchId
     }else{
      branchId=req.body?.branchId
      if(req.get('X-Branch-Id')&&req.get('X-Branch-Id')!==branchId)fail(403,'FORBIDDEN')
      const out=await createIntegrationDraft(db,context,type,req.body,req.get('Idempotency-Key'),{now,requestId})
      transactionAudited=true;result=out.receipt;status=out.replayed?200:201
     }
    }else{
     if(isDetail&&Object.keys(req.query).length)fail(400)
     result=isDetail?await documents.getIntegrationDocument(db,context,type,commercial[2]):await documents.listIntegrationDocuments(db,context,type,req.query)
     if(isDetail&&req.get('X-Branch-Id')&&req.get('X-Branch-Id')!==result.branchId)fail(403,'FORBIDDEN')
    }
   }else{
   if(req.method!=='GET'){res.set('Allow','GET');fail(405,'METHOD_NOT_ALLOWED')}
   validateContextHeaders(req,context)
   const match=/^\/products\/([^/]+)$/.exec(req.path)
   const read={products:catalog.listProducts,categories:catalog.listCategories,prices:catalog.getPrices,availability:catalog.getAvailability,branches:catalog.listBranches}
   if(match){route='/products/:id';if(Object.keys(req.query).length)fail(400);result=await catalog.getProduct(db,context,match[1])}
   else{const name=req.path.replace(/^\//,'').replace(/\/$/,'');if(!Object.hasOwn(read,name))fail(404,'NOT_FOUND');route='/'+name;result=await read[name](db,context,req.query,now)}
   }
  }catch(e){error=e;status=e.integrationCode?({INVALID_INPUT:400,INVALID_KEY:401,FORBIDDEN:403,NOT_FOUND:404,METHOD_NOT_ALLOWED:405,IDEMPOTENCY_CONFLICT:409,CUSTOMER_REVIEW_REQUIRED:409,UNIT_REVIEW_REQUIRED:409,DOCUMENT_REVIEW_REQUIRED:409,PRECONDITION_REQUIRED:428,VERSION_CONFLICT:412,BODY_TOO_LARGE:413,UNSUPPORTED_BODY:415,RATE_LIMIT:429}[e.integrationCode]??503):503}
  if(context&&!transactionAudited){try{await recordUsage(db,context,{route,status,requestId,branchId:context.branches.some(b=>b.id===(branchId||req.query.branchId))?(branchId||req.query.branchId):null},now)}catch{error={integrationCode:'UNAVAILABLE'}}}
  if(error)return publicError(res,error,requestId)
  if(result?.version)res.set('ETag',`"${result.version}"`)
  res.set('Cache-Control','no-store').status(status).json(result)
 })
 return router
}
function requestScope(req){return{companyId:require('../../middlewares/tenant').requireCompany(req),actorId:req.user?.sub,permissions:req.user?.permissions||[],isAdmin:require('../users/roles/policy').isSystemAdmin(req.user?.role),branchId:req.branchId||'all'}}
function createManagementRouter(options={}){
 const router=Router(),clock=options.now||(()=>new Date()),origins=new Set(options.allowedOrigins||require('../../config/httpOrigins'))
 router.use((_req,res,next)=>{res.set('Cache-Control','private, no-store');next()})
 router.use((req,res,next)=>{if((req.get('Authorization')||'').startsWith('Bearer auna_live_'))return publicError(res,{integrationCode:'FORBIDDEN'},randomUUID());next()})
 router.use(options.auth||require('../../middlewares/autenticacion').Auth)
 router.use((req,res,next)=>{if(!['POST','DELETE','PATCH','PUT'].includes(req.method))return next();const origin=req.get('Origin');if(origin?origins.has(origin):!req.get('Cookie')&&/^Bearer (?!auna_live_)\S+$/.test(req.get('Authorization')||''))return next();return publicError(res,{integrationCode:'FORBIDDEN'},randomUUID())})
 const run=(handler,status=200)=>async(req,res)=>{try{const s=(options.scope||requestScope)(req);const out=await handler(database(options),s,req,clock());res.status(status).json(out)}catch(e){publicError(res,e,randomUUID())}}
 router.get('/',run((db,s,r,n)=>management.listCredentials(db,s,r.query,n)))
 router.get('/usage',run((db,s,r,n)=>{object(r.query,['period']);return getUsageSummary(db,s,r.query,n)}))
 router.get('/options',run((db,s,r,n)=>management.getManagementOptions(db,s,r.query,n)))
 router.get('/customer-payment-terms',run((db,s,r,n)=>management.getCustomerPaymentTerms(db,s,r.query,n)))
 router.post('/',run((db,s,r,n)=>management.createCredential(db,s,r.body,n),201))
 router.get('/:id',run((db,s,r,n)=>management.getCredential(db,s,r.params.id,n)))
 router.get('/:id/history',run((db,s,r)=>management.listCredentialAudit(db,s,r.params.id,r.query)))
 router.get('/:id/usage',run((db,s,r,n)=>{object(r.query,['period']);return getUsageSummary(db,s,{...r.query,credentialId:r.params.id},n)}))
 router.post('/:id/replace',run((db,s,r,n)=>management.replaceCredential(db,s,r.params.id,r.body,n),201))
 router.post('/:id/revoke',run((db,s,r,n)=>{if(r.body&&Object.keys(r.body).length)fail(400);return management.revokeCredential(db,s,r.params.id,n)}))
 router.post('/:id/pause',run((db,s,r,n)=>{object(r.body,[]);return management.pauseCredential(db,s,r.params.id,n)}))
 router.post('/:id/resume',run((db,s,r,n)=>{object(r.body,[]);return management.resumeCredential(db,s,r.params.id,n)}))
 router.use((error,_req,res,_next)=>publicError(res,error,randomUUID()))
 return router
}
module.exports={createExternalRouter,createManagementRouter}
