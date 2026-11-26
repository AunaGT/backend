const {isIP}=require('node:net')
const express=require('express')
const {randomUUID}=require('node:crypto')
const {ipKeyGenerator}=require('express-rate-limit')
const messages={INVALID_INPUT:[400,'Solicitud no válida'],INVALID_KEY:[401,'Clave no válida o no disponible'],FORBIDDEN:[403,'Sin permiso para esta operación'],NOT_FOUND:[404,'Recurso no disponible'],KEY_LIMIT:[409,'La empresa ya tiene 20 claves activas. Revoca una antes de crear otra.'],METHOD_NOT_ALLOWED:[405,'Método no permitido'],RATE_LIMIT:[429,'Límite de consultas alcanzado'],UNAVAILABLE:[503,'La integración no está disponible temporalmente'],INSECURE_TRANSPORT:[403,'Usa una conexión HTTPS segura']}
messages.CREDENTIAL_STATE_CONFLICT=[409,'El estado de la clave cambió o su vigencia terminó. Recarga sus datos.']
Object.assign(messages,{PRECONDITION_REQUIRED:[428,'Lee el documento y envía su ETag en If-Match'],VERSION_CONFLICT:[412,'El documento cambió. Lee su versión actual antes de editar'],DOCUMENT_REVIEW_REQUIRED:[409,'El documento necesita revisión en Auna']})
Object.assign(messages,{IDEMPOTENCY_CONFLICT:[409,'La clave de solicitud ya se utilizó con otros datos'],CUSTOMER_REVIEW_REQUIRED:[409,'El cliente necesita revisión en Auna'],UNIT_REVIEW_REQUIRED:[409,'Recarga y revisa las unidades del producto'],BODY_TOO_LARGE:[413,'El cuerpo supera el tamaño permitido'],UNSUPPORTED_BODY:[415,'Envía JSON sin compresión']})
function publicError(res,error,requestId){
 const code=Object.hasOwn(messages,error.integrationCode||'')?error.integrationCode:'UNAVAILABLE',[status,message]=messages[code]
 if(code==='RATE_LIMIT')res.set('Retry-After',String(error.retryAfter||60))
 return res.status(status).json({error:{code,message,requestId}})
}
function secureTransport(req){
 if(req.socket?.encrypted)return true
 const peer=(req.socket?.remoteAddress||'').replace(/^::ffff:/,'')
 if(process.env.NODE_ENV!=='production'&&['127.0.0.1','::1'].includes(peer))return true
 const proxies=(process.env.INTEGRATIONS_TRUSTED_PROXY_IPS||'').split(',').map(x=>x.trim()).filter(isIP)
 return proxies.includes(peer)&&req.secure===true
}
function preAuthKey(req){
 const peer=(req.socket?.remoteAddress||'').replace(/^::ffff:/,'')
 const trusted=(process.env.INTEGRATIONS_TRUSTED_PROXY_IPS||'').split(',').map(x=>x.trim()).filter(isIP).includes(peer)
 return ipKeyGenerator(trusted?req.ip:peer)
}
function createExternalBoundary(){return(req,res,next)=>{
 req.integrationRequestId=randomUUID();res.set('Cache-Control','no-store')
 res.removeHeader('Access-Control-Allow-Origin');res.removeHeader('Access-Control-Allow-Credentials')
 if(!secureTransport(req))return publicError(res,{integrationCode:'INSECURE_TRANSPORT'},req.integrationRequestId)
 if(req.get('Origin'))return publicError(res,{integrationCode:'FORBIDDEN'},req.integrationRequestId)
 next()
}}
function createManagementBoundary(){
 const router=express.Router();router.use((req,res,next)=>{res.set('Cache-Control','private, no-store');if(['POST','PUT','PATCH'].includes(req.method)&&!req.is('application/json'))return res.status(415).json({message:'Envía la solicitud como JSON'});next()});router.use(express.json({limit:'16kb',inflate:false}));
 router.use((error,_req,res,_next)=>res.status(error.type==='entity.too.large'?413:error.status===415?415:400).json({message:'Solicitud de integración no válida'}));return router
}
module.exports={publicError,secureTransport,preAuthKey,createExternalBoundary,createManagementBoundary}
