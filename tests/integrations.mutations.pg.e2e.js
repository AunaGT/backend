// Explicit disposable cluster only. Never load the ERP .env or a fallback URL.
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto'),{PrismaClient}=require('@prisma/client')
const target=process.env.INTEGRATIONS_MUTATIONS_TEST_DATABASE_URL
if(target!=='postgresql://DiegoPatzan@127.0.0.1:55479/postgres'||process.env.DATABASE_URL!==target||process.env.DIRECT_URL!==target)throw Error('Explicit isolated mutation database required')
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve}}
test('real mutation transactions, independent connections and late authorization races',{timeout:60000},async t=>{
 const db=new PrismaClient({datasources:{db:{url:target}}}),other=new PrismaClient({datasources:{db:{url:target}}});t.after(async()=>{await db.$disconnect();await other.$disconnect()})
 const now=new Date('2026-10-26T12:00:00Z'),{createCredential,pauseCredential,resumeCredential}=require('../src/modules/integrations/management'),{authenticateIntegration}=require('../src/modules/integrations/auth'),{createIntegrationDraft}=require('../src/modules/integrations/drafts'),{getIntegrationDocument}=require('../src/modules/integrations/documents'),{mutateIntegrationDraft}=require('../src/modules/integrations/draftMutations'),{lockCommercialDocument,assertDocumentUnchanged}=require('../src/services/commercialDocumentConcurrency')
 const company=await db.company.create({data:{name:'Synthetic mutation API',code:randomUUID().slice(0,12)}})
 const role=await db.role.findFirst({where:{system_key:'ADMIN',company_id:null}})||await db.role.create({data:{name:'admin',system_key:'ADMIN'}})
 const owner=await db.user.create({data:{name:'Synthetic Owner',email:randomUUID()+'@invalid.test',password:'synthetic',role_id:role.id}})
 await db.userCompany.create({data:{company_id:company.id,user_id:owner.id,role_id:role.id}})
 const branch=await db.branch.create({data:{company_id:company.id,name:'QA',code:'QA'}}),nextBranch=await db.branch.create({data:{company_id:company.id,name:'QA second',code:'QA2'}})
 await db.userBranch.createMany({data:[branch,nextBranch].map(b=>({user_id:owner.id,branch_id:b.id}))})
 const customer=await db.supplier.create({data:{company_id:company.id,party_type:'CUSTOMER',name:'Synthetic customer',contact:'Synthetic',tax_id:'123-K'}}),category=await db.productCategory.create({data:{company_id:company.id,name:'QA'}}),stockStatus=await db.stockStatus.create({data:{name:'QA '+randomUUID()}})
 const product=await db.product.create({data:{company_id:company.id,name:'Synthetic product',category_id:category.id,status_id:stockStatus.id,price:'12.50',cost:'0',unit_metadata_version:1}})
 const scope={companyId:company.id,actorId:owner.id,isAdmin:true,permissions:[],branchId:branch.id},input={name:'Synthetic API',ownerId:owner.id,scopes:['quotes.read','quotes.create_draft','quotes.update_draft','quotes.cancel_draft','orders.read','orders.create_draft','orders.update_draft','orders.cancel_draft'],branchIds:[branch.id,nextBranch.id],days:null}
 const credential=await createCredential(db,scope,input,now),ctx=await authenticateIntegration(db,'Bearer '+credential.apiKey,now)
 const make=async(type='QUOTE')=>{const out=await createIntegrationDraft(db,ctx,type,{branchId:branch.id,customerId:customer.id,items:[{productId:product.id,quantity:'1'}]},'create-'+randomUUID(),{now});return{id:out.receipt.id,type,receipt:out.receipt}}
 const read=(document,client=db)=>getIntegrationDocument(client,ctx,document.type,document.id)
 const version=async document=>`"${(await read(document)).version}"`
 const mutate=(document,action,body,etag,key='mutate-'+randomUUID(),client=db)=>mutateIntegrationDraft(client,ctx,document.type,document.id,action,body,key,etag,{now})
 const content=()=>db.$queryRaw`SELECT (SELECT md5(COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id)::text,'[]')) FROM product_stocks r) AS stocks,(SELECT md5(COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id)::text,'[]')) FROM stock_reservations r) AS reservations,(SELECT md5(COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id)::text,'[]')) FROM sales r) AS sales,(SELECT md5(COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id)::text,'[]')) FROM customer_payments r) AS payments,(SELECT md5(COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id)::text,'[]')) FROM journal_entries r) AS ledger`
 const beforeEffects=await content(),document=await make(),etag=await version(document)
 const races=await Promise.allSettled([mutate(document,'UPDATE_DRAFT',{notes:'one'},etag),mutate(document,'UPDATE_DRAFT',{notes:'two'},etag,undefined,other)])
 assert.equal(races.filter(r=>r.status==='fulfilled').length,1);assert.equal(races.find(r=>r.status==='rejected').reason.integrationCode,'VERSION_CONFLICT')
 assert.equal(await db.integrationDraftMutation.count({where:{document_id:document.id}}),1)
 assert.equal(await db.integrationAuditEvent.count({where:{credential_id:credential.credential.id,action:'UPDATE_DRAFT'}}),1)
 const second=await make('ORDER'),secondEtag=await version(second)
 const cancelRace=await Promise.allSettled([mutate(second,'UPDATE_DRAFT',{notes:'concurrent'},secondEtag),mutate(second,'CANCEL_DRAFT',{},secondEtag,undefined,other)])
 assert.equal(cancelRace.filter(r=>r.status==='fulfilled').length,1);assert.ok(['VERSION_CONFLICT','DOCUMENT_REVIEW_REQUIRED'].includes(cancelRace.find(r=>r.status==='rejected').reason.integrationCode))
 assert.deepEqual(await content(),beforeEffects,'allowed mutations must not alter operational data')

 const replayDoc=await make(),oldVersion=await version(replayDoc),replayKey='replay-'+randomUUID(),body={notes:'original mutation'}
 const first=await mutate(replayDoc,'UPDATE_DRAFT',body,oldVersion,replayKey)
 await mutate(replayDoc,'UPDATE_DRAFT',{items:[{productId:product.id,quantity:'2'}]},await version(replayDoc))
 await mutate(replayDoc,'CANCEL_DRAFT',{},await version(replayDoc))
 assert.deepEqual((await mutate(replayDoc,'UPDATE_DRAFT',body,oldVersion,replayKey)).receipt,first.receipt)
 assert.deepEqual((await db.integrationDraftOperation.findUnique({where:{document_id:replayDoc.id}})).receipt,replayDoc.receipt)
 await assert.rejects(()=>mutate(replayDoc,'UPDATE_DRAFT',body,`"${first.receipt.version}"`,replayKey),{integrationCode:'IDEMPOTENCY_CONFLICT'})
 const sameKeyDoc=await make();assert.equal((await mutate(sameKeyDoc,'UPDATE_DRAFT',{notes:'other document'},await version(sameKeyDoc),replayKey)).replayed,false)

 const protectedDoc=await make(),line=await db.commercialDocumentLine.findFirst({where:{document_id:protectedDoc.id}}),protectedVersion=await version(protectedDoc)
 const reservation=await db.stockReservation.create({data:{branch_id:branch.id,document_id:protectedDoc.id,document_line_id:line.id,product_id:product.id,qty:'1',status:'RELEASED'}})
 await assert.rejects(()=>mutate(protectedDoc,'UPDATE_DRAFT',{items:[{productId:product.id,quantity:'3'}]},protectedVersion),{integrationCode:'DOCUMENT_REVIEW_REQUIRED'})
 assert.equal(await db.stockReservation.count({where:{id:reservation.id}}),1)
 await db.stockReservation.delete({where:{id:reservation.id}})

 const rollbackDoc=await make(),rollbackKey='rollback-'+randomUUID(),rollbackVersion=await version(rollbackDoc)
 const snapshot=async()=>JSON.stringify(await db.commercialDocument.findUnique({where:{id:rollbackDoc.id},include:{lines:{orderBy:{id:'asc'}}}})),beforeRollback=await snapshot()
 const broken=new Proxy(db,{get:(o,k)=>k==='$transaction'?(fn,options)=>o.$transaction(tx=>fn(new Proxy(tx,{get:(inner,n)=>n==='integrationAuditEvent'?{create:async()=>{throw Error('synthetic audit failure')}}:inner[n]})),options):o[k]})
 await assert.rejects(()=>mutate(rollbackDoc,'UPDATE_DRAFT',{items:[{productId:product.id,quantity:'3'}]},rollbackVersion,rollbackKey,broken),/synthetic audit failure/)
 assert.equal(await snapshot(),beforeRollback);assert.equal(await db.integrationDraftMutation.count({where:{document_id:rollbackDoc.id}}),0)
 const retry=await mutate(rollbackDoc,'UPDATE_DRAFT',{items:[{productId:product.id,quantity:'3'}]},rollbackVersion,rollbackKey)
 assert.equal(retry.replayed,false);assert.equal(retry.receipt.total,'37.50')
 assert.equal(retry.receipt.version,(await read(rollbackDoc)).version,'receipt carries final revision after nested line triggers')

 // Baseline read before API cancellation: the internal writer must not delete lines.
 const internalDoc=await make(),baseline=await db.commercialDocument.findUnique({where:{id:internalDoc.id}})
 await mutate(internalDoc,'CANCEL_DRAFT',{},await version(internalDoc))
 await assert.rejects(()=>other.$transaction(async tx=>{const current=await lockCommercialDocument(tx,{companyId:company.id,branchId:branch.id,type:'QUOTE'},internalDoc.id);assertDocumentUnchanged(current,baseline.integration_revision);await tx.commercialDocumentLine.deleteMany({where:{document_id:internalDoc.id}})}),{code:'DOCUMENT_CHANGED'})
 assert.equal(await db.commercialDocumentLine.count({where:{document_id:internalDoc.id}}),1)

 async function mutationAfterDocumentWait(change,expected,insideHolder=false){
  const waiting=await make(),waitingVersion=await version(waiting),held=deferred(),attempt=deferred(),release=deferred()
  const holder=db.$transaction(async tx=>{await tx.$queryRaw`SELECT id FROM commercial_documents WHERE id=${waiting.id}::uuid FOR UPDATE`;held.resolve();await release.promise;if(insideHolder)await change(waiting,tx)},{timeout:10000})
  await held.promise
  const observed=new Proxy(other,{get:(o,k)=>k==='$transaction'?(fn,options)=>o.$transaction(tx=>fn(new Proxy(tx,{get:(inner,n)=>n==='$queryRaw'?async(strings,...values)=>{if(strings.join('').includes('FOR UPDATE OF d'))attempt.resolve();return inner.$queryRaw(strings,...values)}:inner[n]})),options):o[k]})
  const work=mutate(waiting,'UPDATE_DRAFT',{notes:'must not commit'},waitingVersion,undefined,observed).then(value=>({value}),error=>({error}))
  try{await attempt.promise;if(!insideHolder)await change(waiting)}finally{release.resolve()}
  await holder;assert.equal((await work).error?.integrationCode,expected)
  assert.equal(await db.integrationDraftMutation.count({where:{document_id:waiting.id}}),0)
  assert.equal((await db.commercialDocument.findUnique({where:{id:waiting.id}})).notes,null)
 }
 await mutationAfterDocumentWait(()=>pauseCredential(other,scope,credential.credential.id,now),'INVALID_KEY')
 await resumeCredential(db,scope,credential.credential.id,now)
 await mutationAfterDocumentWait(async()=>{await other.integrationCredential.update({where:{id:credential.credential.id},data:{expires_at:new Date(now.getTime()+100)}});await other.$executeRaw`SELECT pg_sleep(0.15)`},'INVALID_KEY')
 await db.integrationCredential.update({where:{id:credential.credential.id},data:{expires_at:null}})
 await mutationAfterDocumentWait((waiting,tx)=>tx.commercialDocumentLine.updateMany({where:{document_id:waiting.id},data:{sort_order:1}}),'VERSION_CONFLICT',true)

 // The final contact lock may wait after preparation; expiry must be fresh afterward.
 const contactWaitDoc=await make(),contactWaitVersion=await version(contactWaitDoc),contactHeld=deferred(),contactAttempt=deferred()
 await db.integrationCredential.update({where:{id:credential.credential.id},data:{expires_at:new Date(now.getTime()+100)}})
 const contactHolder=db.$transaction(async tx=>{await tx.$executeRaw`SELECT id FROM public.suppliers WHERE id=${customer.id}::uuid FOR UPDATE`;contactHeld.resolve();await contactAttempt.promise;await tx.$executeRaw`SELECT pg_sleep(0.15)`},{timeout:10000})
 await contactHeld.promise
 const contactObserved=new Proxy(other,{get:(o,k)=>k==='$transaction'?(fn,options)=>o.$transaction(tx=>fn(new Proxy(tx,{get:(inner,n)=>n==='$executeRaw'?async(strings,...values)=>{if(strings.join('').includes('public.suppliers'))contactAttempt.resolve();return inner.$executeRaw(strings,...values)}:inner[n]})),options):o[k]})
 const contactResult=mutate(contactWaitDoc,'UPDATE_DRAFT',{notes:'expired during contact wait'},contactWaitVersion,undefined,contactObserved).then(value=>({value}),error=>({error}))
 await contactHolder
 assert.equal((await contactResult).error?.integrationCode,'INVALID_KEY')
 assert.equal(await db.integrationDraftMutation.count({where:{document_id:contactWaitDoc.id}}),0)
 assert.equal((await db.commercialDocument.findUnique({where:{id:contactWaitDoc.id}})).notes,null)
 await db.integrationCredential.update({where:{id:credential.credential.id},data:{expires_at:null}})

 // A mutation that holds the row serializes internal changes until its commit.
 const serialized=await make(),serializedVersion=await version(serialized),prepared=deferred(),releaseWriter=deferred(),writerAttempt=deferred()
 const gated=new Proxy(db,{get:(o,k)=>k==='$transaction'?(fn,options)=>o.$transaction(tx=>fn(new Proxy(tx,{get:(inner,n)=>n==='supplier'?{findFirst:async args=>{prepared.resolve();await releaseWriter.promise;return inner.supplier.findFirst(args)}}:inner[n]})),options):o[k]})
 const mutation=mutate(serialized,'UPDATE_DRAFT',{notes:'serialized'},serializedVersion,undefined,gated)
 await prepared.promise
 const internal=other.$transaction(async tx=>{writerAttempt.resolve();await tx.$executeRaw`UPDATE commercial_documents SET notes='internal after commit' WHERE id=${serialized.id}::uuid`},{timeout:10000})
 await writerAttempt.promise;releaseWriter.resolve();const mutationOut=await mutation;await internal
 assert.notEqual(mutationOut.receipt.version,(await read(serialized)).version)
 assert.equal((await db.commercialDocument.findUnique({where:{id:serialized.id}})).notes,'internal after commit')

 // A mismatched reservation inserted after eligibility must never be silently
 // cascade-deleted by replacement. At most one concurrent writer may commit.
 const replacementDoc=await make(),reservationHeader=await make(),replaceVersion=await version(replacementDoc),replaceLine=await db.commercialDocumentLine.findFirst({where:{document_id:replacementDoc.id}}),replacePrepared=deferred(),replaceRelease=deferred(),reservationAttempt=deferred()
 const guardedReplacement=new Proxy(db,{get:(o,k)=>k==='$transaction'?(fn,options)=>o.$transaction(tx=>fn(new Proxy(tx,{get:(inner,n)=>n==='supplier'?{findFirst:async args=>{replacePrepared.resolve();await replaceRelease.promise;return inner.supplier.findFirst(args)}}:inner[n]})),options):o[k]})
 const replacing=mutate(replacementDoc,'UPDATE_DRAFT',{items:[{productId:product.id,quantity:'2'}]},replaceVersion,undefined,guardedReplacement).then(value=>({value}),error=>({error}))
 await replacePrepared.promise
 const inserting=other.$transaction(async tx=>{const [connection]=await tx.$queryRaw`SELECT pg_backend_pid() AS pid`;reservationAttempt.resolve(connection.pid);return tx.stockReservation.create({data:{document_id:reservationHeader.id,document_line_id:replaceLine.id,branch_id:branch.id,product_id:product.id,qty:'1'}})},{timeout:10000}).then(value=>({value}),error=>({error}))
 const reservationPid=await reservationAttempt.promise
 let reservationWaiting=false
 try{
  for(let checks=0;checks<100&&!reservationWaiting;checks++){
   const [state]=await db.$queryRaw`SELECT wait_event_type FROM pg_stat_activity WHERE pid=${reservationPid}`
   reservationWaiting=state?.wait_event_type==='Lock'
   if(!reservationWaiting)await new Promise(r=>setTimeout(r,10))
  }
  assert.equal(reservationWaiting,true,'reservation must coordinate with the line owner API lock')
 }finally{replaceRelease.resolve()}
 const [replaceResult,reservationResult]=await Promise.all([replacing,inserting])
 assert.ok(!replaceResult.value||!reservationResult.value,'both conflicting writers cannot commit')
 if(reservationResult.value){assert.equal(await db.stockReservation.count({where:{id:reservationResult.value.id}}),1);assert.equal(await db.commercialDocumentLine.count({where:{id:replaceLine.id}}),1)}

 const coherent=await make(),coherentBefore=await read(coherent),snapshotReady=deferred(),readRelease=deferred()
 const snapshotReader=new Proxy(db,{get:(o,k)=>k==='$transaction'?(fn,options)=>o.$transaction(async tx=>{assert.equal(options.isolationLevel,'RepeatableRead');await tx.$queryRaw`SELECT id FROM commercial_documents WHERE id=${coherent.id}::uuid`;snapshotReady.resolve();await readRelease.promise;return fn(tx)},options):o[k]})
 const snapshotRead=read(coherent,snapshotReader);await snapshotReady.promise
 await mutate(coherent,'UPDATE_DRAFT',{items:[{productId:product.id,quantity:'2'}]},`"${coherentBefore.version}"`,undefined,other)
 readRelease.resolve();const coherentOld=await snapshotRead
 assert.equal(coherentOld.version,coherentBefore.version);assert.equal(coherentOld.items[0].quantity,'1');assert.equal((await read(coherent)).items[0].quantity,'2')

 const moved=await make(),moveVersion=await version(moved),moveKey='move-'+randomUUID(),moveBody={notes:'move replay'}
 const beforeMove=await mutate(moved,'UPDATE_DRAFT',moveBody,moveVersion,moveKey)
 await db.commercialDocument.update({where:{id:moved.id},data:{branch_id:nextBranch.id}})
 await db.userBranch.delete({where:{user_id_branch_id:{user_id:owner.id,branch_id:branch.id}}})
 assert.deepEqual((await mutate(moved,'UPDATE_DRAFT',moveBody,moveVersion,moveKey)).receipt,beforeMove.receipt)
 await db.userBranch.delete({where:{user_id_branch_id:{user_id:owner.id,branch_id:nextBranch.id}}})
 await assert.rejects(()=>mutate(moved,'UPDATE_DRAFT',moveBody,moveVersion,moveKey),{integrationCode:'FORBIDDEN'})
 await db.userBranch.createMany({data:[branch,nextBranch].map(b=>({user_id:owner.id,branch_id:b.id}))})

 const hundred=await make(),beforeHundred=await content(),started=performance.now()
 const batch=await mutate(hundred,'UPDATE_DRAFT',{items:Array.from({length:100},()=>({productId:product.id,quantity:'1'}))},await version(hundred))
 assert.equal((await read(hundred)).items.length,100);assert.equal(batch.receipt.total,'1250.00');assert.equal(batch.receipt.version,(await read(hundred)).version);assert.deepEqual(await content(),beforeHundred)
 assert.ok(performance.now()-started<5000,'100-line replacement must remain bounded without recursive trigger loops');t.diagnostic(`100-line API replacement: ${Math.round(performance.now()-started)} ms`)
 const usage=await require('../src/modules/integrations/usage').getUsageSummary(db,scope,{period:'7d',credentialId:credential.credential.id},new Date(now.getTime()+1000))
 const events=await db.integrationAuditEvent.findMany({where:{credential_id:credential.credential.id,action:{in:['CREATE_DRAFT','UPDATE_DRAFT','CANCEL_DRAFT','USE']},created_at:{gte:new Date(now.getTime()-7*86400000),lt:new Date(now.getTime()+1000)}}})
 assert.equal(usage.total,events.length);assert.ok(usage.byRoute.some(r=>r.route==='/quotes/:id'))
})
