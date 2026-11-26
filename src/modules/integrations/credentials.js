const { randomBytes, createHash, timingSafeEqual } = require('node:crypto')
const SCOPES = Object.freeze(['products.read','categories.read','prices.read','availability.read','quotes.read','quotes.create_draft','quotes.update_draft','quotes.cancel_draft','orders.read','orders.create_draft','orders.update_draft','orders.cancel_draft','customers.create'])
const requiredReadScope = scope => /^(quotes|orders)\.(update|cancel)_draft$/.test(scope)?scope.split('.')[0]+'.read':null
function fail(status,code='INVALID_INPUT'){throw Object.assign(Error(code),{status,integrationCode:code})}
const uuid = v => typeof v==='string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v)
const hash = secret => createHash('sha256').update(secret).digest('hex')
function issueCredential(){
 const publicId=randomBytes(16).toString('hex'),secret=randomBytes(32).toString('base64url')
 return {publicId,secretHash:hash(secret),apiKey:`auna_live_${publicId}.${secret}`}
}
function parseCredential(raw){
 if(typeof raw!=='string'||raw.length!==86)return null
 const match=/^auna_live_([0-9a-f]{32})\.([A-Za-z0-9_-]{43})$/.exec(raw)
 return match?{publicId:match[1],secret:match[2]}:null
}
function verifySecret(secret,expected){
 return typeof secret==='string'&&typeof expected==='string'&&/^[0-9a-f]{64}$/.test(expected)&&timingSafeEqual(Buffer.from(hash(secret),'hex'),Buffer.from(expected,'hex'))
}
function object(input,allowed){if(!input||typeof input!=='object'||Array.isArray(input)||![Object.prototype,null].includes(Object.getPrototypeOf(input))||Object.keys(input).some(k=>!allowed.includes(k)))fail(400)}
function parseCreateInput(input){
 object(input,['name','ownerId','scopes','branchIds','days','customerPolicy','customerPaymentTermId'])
 if(typeof input.name!=='string'||!input.name.trim()||input.name.trim().length>100||/[\x00-\x1f]/.test(input.name)||!uuid(input.ownerId))fail(400)
 if(!Array.isArray(input.scopes)||!input.scopes.length||input.scopes.length>SCOPES.length||input.scopes.some(s=>!SCOPES.includes(s)))fail(400)
 if(input.scopes.some(s=>requiredReadScope(s)&&!input.scopes.includes(requiredReadScope(s))))fail(400)
 if(!Array.isArray(input.branchIds)||!input.branchIds.length||input.branchIds.length>100||input.branchIds.some(b=>!uuid(b)))fail(400)
 const days=input.days===undefined?90:input.days
 if(days!==null&&(!Number.isInteger(days)||days<1||days>365))fail(400)
 const customerPolicy=input.customerPolicy??'EXISTING_ONLY',customerPaymentTermId=input.customerPaymentTermId??null
 if(!['EXISTING_ONLY','CREATE_IF_MISSING'].includes(customerPolicy))fail(400)
 const canCreate=input.scopes.includes('customers.create')
 if(customerPolicy==='CREATE_IF_MISSING'){
  if(!canCreate||!input.scopes.some(s=>s==='quotes.create_draft'||s==='orders.create_draft')||!Number.isSafeInteger(customerPaymentTermId)||customerPaymentTermId<1)fail(400)
 }else if(canCreate||customerPaymentTermId!==null)fail(400)
 return{name:input.name.trim(),ownerId:input.ownerId,scopes:[...new Set(input.scopes)],branchIds:[...new Set(input.branchIds)],days,customerPolicy,customerPaymentTermId}
}
function pageQuery(query={}){
 object(query,['page','pageSize']);const page=Number(query.page??1),pageSize=Number(query.pageSize??20)
 if(!Number.isSafeInteger(page)||page<1||page>100000||!Number.isSafeInteger(pageSize)||pageSize<1||pageSize>100)fail(400)
 return{page,pageSize}
}
// Only an explicit database null means no expiry; missing/malformed data fails closed.
function isExpired(expiresAt,now){return expiresAt!==null&&(!(expiresAt instanceof Date)||!Number.isFinite(expiresAt.getTime())||expiresAt<=now)}
module.exports={SCOPES,requiredReadScope,uuid,fail,object,issueCredential,parseCredential,verifySecret,parseCreateInput,pageQuery,isExpired}
