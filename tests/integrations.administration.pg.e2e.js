// Opt-in isolated cluster only. Never fall back to the ERP environment.
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto'),{spawnSync}=require('node:child_process'),{PrismaClient}=require('@prisma/client')
const target=process.env.INTEGRATIONS_ADMIN_TEST_DATABASE_URL
if(target!=='postgresql://DiegoPatzan@127.0.0.1:55469/postgres'||process.env.DATABASE_URL!==target||process.env.DIRECT_URL!==target)throw Error('Explicit isolated administration database required')
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve}}
test('real SQL migration, state races, exact usage and prepared-write pause',async t=>{
 const db=new PrismaClient({datasources:{db:{url:target}}}),other=new PrismaClient({datasources:{db:{url:target}}});t.after(async()=>{await db.$disconnect();await other.$disconnect()})
 const m=require('../src/modules/integrations/management'),{authenticateIntegration}=require('../src/modules/integrations/auth'),{getUsageSummary}=require('../src/modules/integrations/usage'),now=new Date('2026-10-26T12:00:00Z')
 const company=await db.company.create({data:{name:'Synthetic API Admin',code:randomUUID().slice(0,12)}}),foreign=await db.company.create({data:{name:'Synthetic other',code:randomUUID().slice(0,12)}})
 const role=await db.role.findFirst({where:{system_key:'ADMIN',company_id:null}})||await db.role.create({data:{name:'admin',system_key:'ADMIN'}})
 const owner=await db.user.create({data:{name:'Synthetic Owner',email:randomUUID()+'@invalid.test',password:'synthetic',role_id:role.id}})
 await db.userCompany.create({data:{company_id:company.id,user_id:owner.id,role_id:role.id}})
 const branch=await db.branch.create({data:{company_id:company.id,name:'QA',code:'QA'}});await db.userBranch.create({data:{user_id:owner.id,branch_id:branch.id}})
 const scope={companyId:company.id,actorId:owner.id,isAdmin:true,permissions:[],branchId:branch.id},input={name:'Web',ownerId:owner.id,scopes:['products.read'],branchIds:[branch.id],days:null}
 // Reconstruct only the previous administration contract in this disposable DB.
 await db.$executeRawUnsafe('ALTER TABLE integration_credentials DROP COLUMN paused_at')
 await db.$executeRawUnsafe('DROP INDEX integration_audit_events_company_id_created_at_id_idx')
 await db.$executeRawUnsafe('ALTER TABLE integration_audit_events DROP CONSTRAINT integration_audit_events_action_check')
 await db.$executeRawUnsafe("ALTER TABLE integration_audit_events ADD CONSTRAINT integration_audit_events_action_check CHECK(action IN ('CREATE','REPLACE','REVOKE','USE','CREATE_DRAFT')) NOT VALID")
 const oldId=randomUUID(),publicId=randomUUID().replaceAll('-',''),deadline=new Date(now.getTime()+86400000)
 await db.integrationIdentity.create({data:{id:oldId,company_id:company.id,created_at:now}})
 await db.$executeRaw`INSERT INTO integration_credentials(id,company_id,integration_id,owner_id,created_by,name,public_id,secret_hash,scopes,created_at,expires_at) VALUES(${oldId}::uuid,${company.id}::uuid,${oldId}::uuid,${owner.id}::uuid,${owner.id}::uuid,'Old Web',${publicId},${'a'.repeat(64)},ARRAY['products.read'],${now.toISOString()}::timestamp,${deadline.toISOString()}::timestamp)`
 await db.integrationCredentialBranch.create({data:{company_id:company.id,credential_id:oldId,branch_id:branch.id}})
 await assert.rejects(()=>m.pauseCredential(db,scope,oldId,now))
 const migration=spawnSync('psql',[target,'-v','ON_ERROR_STOP=1','-f','prisma/migrations/20261026090000_integration_administration/migration.sql'],{encoding:'utf8'});assert.equal(migration.status,0,migration.stderr)
 const old=await db.integrationCredential.findUnique({where:{id:oldId}})
 assert.equal(old.paused_at,null);assert.equal(old.expires_at.toISOString(),deadline.toISOString());assert.deepEqual(old.scopes,['products.read']);assert.equal(old.secret_hash,'a'.repeat(64));assert.equal(old.integration_id,oldId)
 const schema=await db.$queryRaw`SELECT c.relrowsecurity,(SELECT count(*)::int FROM pg_policy p WHERE p.polrelid=c.oid) AS policies FROM pg_class c WHERE c.relname IN ('integration_credentials','integration_audit_events')`
 assert.equal(schema.length,2);assert.ok(schema.every(r=>r.relrowsecurity&&r.policies===0))
 assert.equal((await db.$queryRaw`SELECT count(*)::int AS n FROM pg_indexes WHERE indexname='integration_audit_events_company_id_created_at_id_idx'`)[0].n,1)

 const key=await m.createCredential(db,scope,input,now)
 await m.pauseCredential(db,scope,key.credential.id,now)
 await assert.rejects(()=>authenticateIntegration(db,'Bearer '+key.apiKey,now),{status:401})
 const replacement=await m.replaceCredential(other,scope,key.credential.id,input,now);assert.equal(replacement.credential.status,'PAUSED')
 const races=await Promise.allSettled([m.resumeCredential(db,scope,key.credential.id,now),m.revokeCredential(other,scope,key.credential.id,now),m.pauseCredential(db,scope,key.credential.id,now)])
 assert.ok(races.some(r=>r.status==='fulfilled'))
 assert.equal((await m.getCredential(db,scope,key.credential.id,now)).status,'REVOKED')
 await assert.rejects(()=>m.resumeCredential(db,scope,key.credential.id,now),{status:409})
 assert.equal(await db.integrationAuditEvent.count({where:{credential_id:key.credential.id,action:'REVOKE'}}),1)
 await m.resumeCredential(db,scope,replacement.credential.id,now)
 assert.equal((await authenticateIntegration(db,'Bearer '+replacement.apiKey,now)).credentialId,replacement.credential.id)
 const broken=new Proxy(db,{get:(o,k)=>k==='$transaction'?(fn,options)=>o.$transaction(tx=>fn(new Proxy(tx,{get:(inner,n)=>n==='integrationAuditEvent'?{create:async()=>{throw Error('synthetic audit outage')}}:inner[n]})),options):o[k]})
 await assert.rejects(()=>m.pauseCredential(broken,scope,replacement.credential.id,now))
 assert.equal((await m.getCredential(db,scope,replacement.credential.id,now)).status,'ACTIVE')

 const special=await m.createCredential(db,scope,{...input,name:'Café %_literal'},now)
 assert.equal((await m.listCredentials(db,scope,{q:'%_'},now)).total,1)
 assert.equal((await m.listCredentials(db,scope,{q:'Café'},now)).items[0].id,special.credential.id)
 assert.equal((await m.listCredentials(db,scope,{q:publicId.slice(0,12)},now)).items[0].id,oldId)
 const pages=await Promise.all([1,2].map(page=>m.listCredentials(db,scope,{page:String(page),pageSize:'1'},now)))
 assert.notEqual(pages[0].items[0].id,pages[1].items[0].id)
 assert.equal((await m.listCredentials(db,{...scope,companyId:foreign.id},{q:'Web'},now)).total,0)
 for(const status of ['ACTIVE','PAUSED','EXPIRED','REVOKED']){const list=await m.listCredentials(db,scope,{status},now);assert.ok(list.items.every(r=>r.status===status))}

 // Hand-counted five external requests; admin actions and time boundaries excluded.
 const at=new Date(now.getTime()-1000),from=new Date(now.getTime()-7*86400000)
 const event=(action,status,route,created_at=at,metadata={})=>({id:randomUUID(),company_id:company.id,credential_id:oldId,action,status,route,created_at,metadata})
 await db.integrationAuditEvent.createMany({data:[event('CREATE_DRAFT',null,null,at,{type:'QUOTE'}),event('CREATE_DRAFT',201,'/quotes'),event('USE',200,'/branches',from),event('USE',400,'/quotes'),event('USE',503,'/quotes'),event('PAUSE',null,null),event('USE',200,'/quotes',new Date(from.getTime()-1)),event('USE',200,'/quotes',now)]})
 const usage=await getUsageSummary(db,scope,{period:'7d',credentialId:oldId},now)
 assert.equal(usage.total,5);assert.equal(usage.successful,3);assert.equal(usage.errors,2);assert.equal(usage.errorRate,0.4)
 assert.deepEqual(usage.byRoute,[{route:'/quotes',count:4},{route:'/branches',count:1}])
 const zero=await getUsageSummary(db,scope,{period:'7d',credentialId:special.credential.id},now);assert.equal(zero.total,0);assert.equal(zero.errorRate,null)
 await assert.rejects(()=>getUsageSummary(db,{...scope,companyId:foreign.id},{period:'7d',credentialId:oldId},now),{status:404})

 // Pause from the other connection after preparation but before final authorization.
 const draftKey=await m.createCredential(db,scope,{...input,scopes:['quotes.create_draft']},now),ctx=await authenticateIntegration(db,'Bearer '+draftKey.apiKey,now)
 const customer=await db.supplier.create({data:{company_id:company.id,party_type:'CUSTOMER',name:'Synthetic customer',contact:'Synthetic',tax_id:'123-K'}})
 const category=await db.productCategory.create({data:{company_id:company.id,name:'QA'}}),status=await db.stockStatus.create({data:{name:'QA '+randomUUID()}})
 const product=await db.product.create({data:{company_id:company.id,name:'Synthetic product',category_id:category.id,status_id:status.id,price:'12.50',cost:'0',unit_metadata_version:1}})
 const reached=deferred(),release=deferred()
 const gated=new Proxy(db,{get:(o,k)=>k==='$transaction'?(fn,options)=>o.$transaction(tx=>fn(new Proxy(tx,{get:(inner,n)=>n==='systemSetting'?{...inner[n],findMany:async args=>{if(args.where.key.in.includes('quote_validity_days')){reached.resolve();await release.promise}return inner[n].findMany(args)}}:inner[n]})),options):o[k]})
 const counters=()=>Promise.all([db.commercialDocument.count(),db.integrationDraftOperation.count(),db.productStock.count(),db.stockReservation.count(),db.sale.count(),db.journalEntry.count()]),before=await counters()
 const work=require('../src/modules/integrations/drafts').createIntegrationDraft(gated,ctx,'QUOTE',{branchId:branch.id,customerId:customer.id,items:[{productId:product.id,quantity:'1'}]},'pause-before-insert-123',{now})
 const rejected=assert.rejects(work,{status:401})
 try{await reached.promise;await m.pauseCredential(other,scope,draftKey.credential.id,now)}finally{release.resolve()}
 await rejected;assert.deepEqual(await counters(),before)

 const restricted=await db.role.create({data:{name:'Restricted '+randomUUID(),company_id:company.id}})
 const secondary=await db.user.create({data:{name:'Synthetic secondary',email:randomUUID()+'@invalid.test',password:'synthetic',role_id:role.id}})
 await db.userCompany.create({data:{company_id:company.id,user_id:secondary.id,role_id:role.id}});await db.userBranch.create({data:{user_id:secondary.id,branch_id:branch.id}})
 const waitingKey=await m.createCredential(db,scope,{...input,ownerId:secondary.id},now)
 await m.pauseCredential(db,scope,waitingKey.credential.id,now)
 async function resumeAfterWait(change,expected){
  const held=deferred(),releaseLock=deferred(),attempt=deferred(),beforeEvents=await db.integrationAuditEvent.count({where:{credential_id:waitingKey.credential.id}})
  const holder=db.$transaction(async tx=>{await tx.$executeRaw`SELECT id FROM companies WHERE id=${company.id}::uuid FOR NO KEY UPDATE`;held.resolve();await releaseLock.promise},{timeout:10000})
  await held.promise
  const observed=new Proxy(other,{get:(o,k)=>k==='$transaction'?(fn,options)=>o.$transaction(tx=>fn(new Proxy(tx,{get:(inner,n)=>n==='$executeRaw'?async(strings,...values)=>{if(strings.join('').includes('FROM companies'))attempt.resolve();return inner.$executeRaw(strings,...values)}:inner[n]})),options):o[k]})
  const result=m.resumeCredential(observed,scope,waitingKey.credential.id,now).then(()=>({ok:true}),error=>({ok:false,error}))
  try{await attempt.promise;await change()}finally{releaseLock.resolve()}
  await holder;const out=await result;assert.equal(out.ok,false);assert.equal(out.error.status,expected)
  assert.equal(await db.integrationAuditEvent.count({where:{credential_id:waitingKey.credential.id}}),beforeEvents)
  assert.ok((await db.integrationCredential.findUnique({where:{id:waitingKey.credential.id}})).paused_at)
 }
 await resumeAfterWait(()=>other.userCompany.update({where:{user_id_company_id:{user_id:secondary.id,company_id:company.id}},data:{role_id:restricted.id}}),403)
 await db.userCompany.update({where:{user_id_company_id:{user_id:secondary.id,company_id:company.id}},data:{role_id:role.id}})
 await resumeAfterWait(()=>other.userCompany.update({where:{user_id_company_id:{user_id:owner.id,company_id:company.id}},data:{role_id:restricted.id}}),403)
 await db.userCompany.update({where:{user_id_company_id:{user_id:owner.id,company_id:company.id}},data:{role_id:role.id}})
 await db.integrationCredential.update({where:{id:waitingKey.credential.id},data:{expires_at:new Date(now.getTime()+100)}})
 await resumeAfterWait(()=>other.$executeRaw`SELECT pg_sleep(0.15)`,409)
 await db.integrationCredential.update({where:{id:waitingKey.credential.id},data:{expires_at:null}})

 async function draftAfterCredentialWait(change){
  await m.resumeCredential(db,scope,draftKey.credential.id,now)
  const held=deferred(),attempt=deferred(),beforeRows=await counters(),beforeEvents=await db.integrationAuditEvent.count({where:{credential_id:draftKey.credential.id}})
  const holder=db.$transaction(async tx=>{await tx.$executeRaw`SELECT id FROM integration_credentials WHERE id=${draftKey.credential.id}::uuid FOR UPDATE`;held.resolve();await attempt.promise;await change(tx)},{timeout:10000})
  await held.promise
  const observed=new Proxy(other,{get:(o,k)=>k==='$transaction'?(fn,options)=>o.$transaction(tx=>fn(new Proxy(tx,{get:(inner,n)=>n==='$executeRaw'?async(strings,...values)=>{if(strings.join('').includes('FROM integration_credentials'))attempt.resolve();return inner.$executeRaw(strings,...values)}:inner[n]})),options):o[k]})
  const work=require('../src/modules/integrations/drafts').createIntegrationDraft(observed,ctx,'QUOTE',{branchId:branch.id,customerId:customer.id,items:[{productId:product.id,quantity:'1'}]},'credential-wait-'+randomUUID(),{now})
  const result=assert.rejects(work,e=>[401,403].includes(e.status))
  await holder;await result;assert.deepEqual(await counters(),beforeRows)
  assert.equal(await db.integrationAuditEvent.count({where:{credential_id:draftKey.credential.id}}),beforeEvents)
 }
 await draftAfterCredentialWait(async tx=>{await tx.integrationCredential.update({where:{id:draftKey.credential.id},data:{expires_at:new Date(now.getTime()+100)}});await tx.$executeRaw`SELECT pg_sleep(0.15)`})
 await db.integrationCredential.update({where:{id:draftKey.credential.id},data:{expires_at:null}})
 await draftAfterCredentialWait(tx=>tx.userCompany.update({where:{user_id_company_id:{user_id:owner.id,company_id:company.id}},data:{role_id:restricted.id}}))
 await db.userCompany.update({where:{user_id_company_id:{user_id:owner.id,company_id:company.id}},data:{role_id:role.id}})

 const replaceGate=deferred(),replaceReady=deferred(),replaceAttempt=deferred()
 const revoker=new Proxy(db,{get:(o,k)=>k==='$transaction'?(fn,options)=>o.$transaction(tx=>fn(new Proxy(tx,{get:(inner,n)=>n==='$executeRaw'?async(strings,...values)=>{const out=await inner.$executeRaw(strings,...values);if(strings.join('').includes('FROM companies')){replaceReady.resolve();await replaceGate.promise}return out}:inner[n]})),options):o[k]})
 const heldRevoke=m.revokeCredential(revoker,scope,special.credential.id,now)
 await replaceReady.promise
 const replacer=new Proxy(other,{get:(o,k)=>k==='$transaction'?(fn,options)=>o.$transaction(tx=>fn(new Proxy(tx,{get:(inner,n)=>n==='$executeRaw'?async(strings,...values)=>{if(strings.join('').includes('FROM companies'))replaceAttempt.resolve();return inner.$executeRaw(strings,...values)}:inner[n]})),options):o[k]})
 const replaceWork=m.replaceCredential(replacer,scope,special.credential.id,input,now)
 const refusedReplacement=assert.rejects(replaceWork,{status:403})
 await replaceAttempt.promise;replaceGate.resolve();await heldRevoke;await refusedReplacement
 assert.equal(await db.integrationCredential.count({where:{replaces_id:special.credential.id}}),0)

 // A final authorized replay and a pause must not invert company/credential locks.
 await m.resumeCredential(db,scope,draftKey.credential.id,now)
 const keyHeld=deferred(),companyHeld=deferred(),allowAdmin=deferred(),allowAudit=deferred()
 const usageWork=db.$transaction(async tx=>{
  const fresh=await require('../src/modules/integrations/policy').revalidateDraftContext(tx,ctx,'QUOTE',branch.id,now,{lockCredential:true})
  keyHeld.resolve();await allowAudit.promise
  await require('../src/modules/integrations/audit').recordUsageInTransaction(tx,fresh,{route:'/quotes',status:200,branchId:branch.id,requestId:null},now)
 },{timeout:10000})
 const usageResult=usageWork.then(()=>({ok:true}),error=>({ok:false,error}))
 await keyHeld.promise
 const gatedAdmin=new Proxy(other,{get:(o,k)=>k==='$transaction'?(fn,options)=>o.$transaction(tx=>fn(new Proxy(tx,{get:(inner,n)=>n==='$executeRaw'?async(strings,...values)=>{const out=await inner.$executeRaw(strings,...values);if(strings.join('').includes('FROM companies')){companyHeld.resolve();await allowAdmin.promise}return out}:inner[n]})),options):o[k]})
 const pauseResult=m.pauseCredential(gatedAdmin,scope,draftKey.credential.id,now).then(()=>({ok:true}),error=>({ok:false,error}))
 await companyHeld.promise;allowAdmin.resolve();allowAudit.resolve()
 const simultaneous=await Promise.all([usageResult,pauseResult])
 assert.deepEqual(simultaneous.map(r=>r.ok),[true,true],'authorized replay and pause must both commit without a deadlock')
 assert.equal((await m.getCredential(db,scope,draftKey.credential.id,now)).status,'PAUSED')

 // Simultaneous non-expiring paused keys cannot escape the company ceiling.
 const activeWhere={company_id:company.id,revoked_at:null,OR:[{expires_at:null},{expires_at:{gt:now}}]},count=await db.integrationCredential.count({where:activeWhere})
 const created=await Promise.allSettled(Array.from({length:21-count},(_,i)=>m.createCredential(i%2?db:other,scope,input,now)))
 assert.equal(created.filter(r=>r.status==='fulfilled').length,20-count)
 assert.equal(created.filter(r=>r.status==='rejected').length,1)
 assert.equal(await db.integrationCredential.count({where:activeWhere}),20)
 for(const r of created)if(r.status==='fulfilled')await m.pauseCredential(db,scope,r.value.credential.id,now)
 await assert.rejects(()=>m.createCredential(other,scope,input,now),{integrationCode:'KEY_LIMIT'})
})
