const {performance}=require('node:perf_hooks')
const {randomUUID}=require('node:crypto')
const {rollbackCheckout,quietDiagnostic}=require('./diagnose-pos-checkout')
function parseDiagnosticArgs(args){if(args.length!==1||args[0]!=='--rollback')throw Error('ROLLBACK_OPT_IN_REQUIRED');return true}
const safeCodes=new Set(['ROLLBACK_OPT_IN_REQUIRED','DATABASE_SCOPE_MISMATCH','EXISTING_SALE_REQUIRED','EXISTING_SESSION_REQUIRED','AUTHORITY_PARITY_FAILED','ROLLBACK_VERIFICATION_FAILED','BRANCH_ACCESS_REQUIRED'])
function safeErrorCode(error){const code=error?.code||error?.message;return safeCodes.has(code)||/^P\d{4}$/.test(code||'')?code:'DIAGNOSTIC_FAILED'}

// Independent old ORM read, used only to compare fresh authorization and latency.
async function legacySession(db,payload){
 const user=await db.user.findUnique({where:{id:payload.sub},include:{user_companies:{include:{company:{select:{active:true}}}},user_branches:{select:{branch:{select:{id:true,company_id:true,active:true,is_default:true}}}}}})
 if(!user||user.auth_version!==(payload.auth_version||0))throw Error('AUTHORITY_PARITY_FAILED')
 if(!await db.refreshToken.findFirst({where:{user_id:user.id,session_id:payload.sid,revoked_at:null,expires_at:{gt:new Date()}},select:{id:true}}))throw Error('EXISTING_SESSION_REQUIRED')
 const ids=[...new Set([user.role_id,...user.user_companies.map(m=>m.role_id)].filter(Number.isSafeInteger))]
 const roles=await db.role.findMany({where:{id:{in:ids}},include:{permissions:{include:{permission:true}}}}),byId=new Map(roles.map(r=>[r.id,r]))
 user.role=byId.get(user.role_id);user.user_companies=user.user_companies.map(m=>({...m,role:m.role_id==null?null:byId.get(m.role_id)}))
 user.must_change_password=await require('../src/services/userAccess').requiresPasswordChange(user,db)
 return user
}
function authority(user){
 const role=r=>r?{id:r.id,name:r.name,company:r.company_id??null,systemKey:r.system_key??null,permissions:(r.permissions||[]).map(p=>p.permission.code).sort()}:null
 return {id:user.id,version:user.auth_version,passwordRequired:user.must_change_password,defaultBranch:user.default_branch_id,role:role(user.role),
  companies:user.user_companies.map(m=>({id:m.company_id,status:m.status,active:m.company.active,role:role(m.role)})).sort((a,b)=>a.id.localeCompare(b.id)),
  branches:user.user_branches.map(m=>m.branch).sort((a,b)=>a.id.localeCompare(b.id))}
}
const equivalentAuthority=(a,b)=>require('node:util').isDeepStrictEqual(authority(a),authority(b))
async function main(args){
 parseDiagnosticArgs(args)
 require('../src/config/loadEnv')
 const {PrismaClient}=require('@prisma/client'),pooled=new URL(process.env.DATABASE_URL),direct=new URL(process.env.DIRECT_URL)
 if(pooled.hostname!==direct.hostname||pooled.username!==direct.username||pooled.pathname!==direct.pathname||!direct.hostname.endsWith('.supabase.com'))throw Error('DATABASE_SCOPE_MISMATCH')
 const clients=[],queries=[];let phase='setup'
 const client=url=>{
  const db=new PrismaClient({datasources:{db:{url:url.toString()}},log:[{emit:'event',level:'query'}]})
  db.$on('query',e=>{
   const operation=/^\s*([A-Z]+)/i.exec(e.query)?.[1]||'OTHER'
   const table=e.query.includes('FROM users u')?'session_snapshot':e.query.includes('FROM sales s')?'ticket_snapshot':/\b(?:FROM|INTO|UPDATE)\s+(?:"?public"?\.)?"?([a-z_]+)"?/i.exec(e.query)?.[1]||'transaction'
   queries.push({phase,operation,table,ms:e.duration})
  });clients.push(db);return db
 }
 const db=client(pooled),transactions=client(direct),times=[]
 const timed=async(label,run)=>{phase=label;const start=performance.now(),before=queries.length;try{return await run()}finally{times.push({phase:label,ms:Math.round(performance.now()-start),sql:queries.length-before,selects:queries.slice(before).filter(q=>q.operation==='SELECT').length})}}
 try{
  const {value,suppressedMessages}=await quietDiagnostic(async()=>{
   const {withMocks}=require('../tests/helpers/reportHarness.cjs')
   const sale=await db.sale.findFirst({where:{createdBy:{role:{name:'admin'}},status:{name:'Completada'}},select:{id:true,branch_id:true,createdBy:{select:{id:true,auth_version:true}},branch:{select:{company_id:true}}},orderBy:{date:'desc'}})
   if(!sale)throw Error('EXISTING_SALE_REQUIRED')
   const session=await db.refreshToken.findFirst({where:{user_id:sale.createdBy.id,revoked_at:null,expires_at:{gt:new Date()}},select:{session_id:true}})
   if(!session)throw Error('EXISTING_SESSION_REQUIRED')
   const payload={sub:sale.createdBy.id,auth_version:sale.createdBy.auth_version,sid:session.session_id}
   await db.$queryRawUnsafe('SELECT 1');await transactions.$queryRawUnsafe('SELECT 1')
   const legacy=await timed('session_before',()=>legacySession(db,payload))
   let jobId,documentBytes,inlineLogo
   const requestKey=randomUUID()
   await withMocks({[require.resolve('../src/models/prisma')]:{prisma:db,prismaTransaction:transactions}},require.resolve('../src/services/userAccess'),async access=>{
    const user=await timed('session_after',()=>access.loadSessionUser(payload,{includeBranches:true}))
    if(!equivalentAuthority(user,legacy))throw Error('AUTHORITY_PARITY_FAILED')
    const effective=access.effectiveUser(user,sale.branch.company_id)
    if(!user.user_branches.some(m=>m.branch.id===sale.branch_id&&m.branch.active))throw Error('BRANCH_ACCESS_REQUIRED')
    const scope={companyId:sale.branch.company_id,branchId:sale.branch_id,actorId:user.id,permissions:effective.permissions,isAdmin:require('../src/modules/users/roles/policy').isSystemAdmin(effective.role)}
    const jobs=require('../src/modules/config/hardware/printing/service')
    await rollbackCheckout(transactions,async tx=>{
     const boundary={$transaction:run=>run(tx)}
     const prepared=await timed('ticket_prepare_with_logo',()=>jobs.createJob(boundary,scope,{requestKey,source:{kind:'SALE_TICKET',id:sale.id},document:'MAIN'},{includeDocument:true,includeLogo:true}))
     jobId=prepared.job.id;documentBytes=Buffer.byteLength(JSON.stringify(prepared.document));inlineLogo=!!prepared.document.options.logoDataUrl
     await timed('session_second_request',()=>access.loadSessionUser(payload,{includeBranches:true}))
     await timed('ticket_events',()=>jobs.recordPreparedDownload(boundary,scope,jobId,{preparedRequestKey:randomUUID(),downloadRequestKey:randomUUID()}))
    })
   })
   phase='verify'
   if(await db.hardwarePrintJob.count({where:{request_key:requestKey}})||await db.hardwarePrintEvent.count({where:{job_id:jobId}}))throw Error('ROLLBACK_VERIFICATION_FAILED')
   const groups=new Map()
   for(const q of queries.filter(q=>!['setup','verify'].includes(q.phase))){const key=[q.phase,q.operation,q.table].join(' '),r=groups.get(key)||{key,count:0,ms:0};r.count++;r.ms+=q.ms;groups.set(key,r)}
   return{scope:'services and real session loader; excludes HTTP, browser render/download and commit',rolledBack:true,authorizationParity:true,documentBytes,inlineLogo,times,queries:[...groups.values()]}
  })
  console.log(JSON.stringify({...value,suppressedMessages},null,2))
 }catch(error){error.diagnosticPhase=phase;throw error}finally{await Promise.all(clients.map(db=>db.$disconnect()))}
}
if(require.main===module)main(process.argv.slice(2)).catch(e=>{console.error(JSON.stringify({status:'error',code:safeErrorCode(e),phase:e.diagnosticPhase}));process.exitCode=1})
module.exports={parseDiagnosticArgs,safeErrorCode,equivalentAuthority,main}
