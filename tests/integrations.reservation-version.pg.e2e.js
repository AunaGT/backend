const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto'),{spawnSync}=require('node:child_process'),{PrismaClient}=require('@prisma/client')
const target=process.env.INTEGRATIONS_MUTATIONS_TEST_DATABASE_URL
if(target!=='postgresql://DiegoPatzan@127.0.0.1:55479/postgres'||process.env.DATABASE_URL!==target||process.env.DIRECT_URL!==target)throw Error('Explicit isolated mutation database required')
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve}}
test('mismatched historical reservations invalidate and lock both document owners',{timeout:30000},async t=>{
 const db=new PrismaClient({datasources:{db:{url:target}}}),other=new PrismaClient({datasources:{db:{url:target}}});t.after(async()=>{await db.$disconnect();await other.$disconnect()})
 const company=await db.company.create({data:{name:'Synthetic reservation revision',code:randomUUID().slice(0,12)}}),branch=await db.branch.create({data:{company_id:company.id,name:'QA',code:'QA'}}),category=await db.productCategory.create({data:{company_id:company.id,name:'QA'}}),status=await db.stockStatus.create({data:{name:'QA '+randomUUID()}})
 const product=await db.product.create({data:{company_id:company.id,name:'Synthetic product',category_id:category.id,status_id:status.id,price:'1',cost:'0'}})
 const make=()=>db.commercialDocument.create({data:{branch_id:branch.id,doc_type:'ORDER',total:'1',lines:{create:[{product_id:product.id,qty:'1',item_name:'Synthetic',item_kind:'STANDARD',unit_label:'unidad',unit_price:'1',line_total:'1'}]}},include:{lines:true}})
 const a=await make(),b=await make(),c=await make()
 const revision=async id=>(await db.commercialDocument.findUnique({where:{id},select:{integration_revision:true}})).integration_revision
 const data={document_id:b.id,document_line_id:a.lines[0].id,branch_id:branch.id,product_id:product.id,qty:'1',status:'RELEASED'}
 // Verify the previously applied migration really missed the independent line owner.
 if(process.env.INTEGRATIONS_EXPECT_RESERVATION_FIX_RED==='1'){
  const before=await revision(a.id)
  await db.stockReservation.create({data})
  assert.notEqual(await revision(a.id),before,'line owner must rotate even if header FK points elsewhere')
  return
 }
 if(process.env.INTEGRATIONS_SKIP_RESERVATION_FIX_APPLY!=='1'){
  const run=spawnSync('psql',[target,'-v','ON_ERROR_STOP=1','-f','prisma/migrations/20261026110000_integration_reservation_revision_guard/migration.sql'],{encoding:'utf8'})
  assert.equal(run.status,0,run.stderr)
 }
 const changed=async(ids,fn)=>{const before=await Promise.all(ids.map(revision)),out=await fn(),after=await Promise.all(ids.map(revision));ids.forEach((id,i)=>assert.notEqual(after[i],before[i],`revision must rotate: ${id}`));return out}
 const reservation=await changed([a.id,b.id],()=>db.stockReservation.create({data}))
 await changed([a.id,b.id,c.id],()=>db.stockReservation.update({where:{id:reservation.id},data:{document_id:c.id,document_line_id:b.lines[0].id}}))
 await changed([b.id,c.id],()=>db.stockReservation.delete({where:{id:reservation.id}}))
 const beforeRollback=await Promise.all([a.id,b.id].map(revision))
 await assert.rejects(()=>db.$transaction(async tx=>{await tx.stockReservation.create({data});throw Error('synthetic rollback')}))
 assert.deepEqual(await Promise.all([a.id,b.id].map(revision)),beforeRollback)
 const held=deferred(),attempt=deferred(),release=deferred()
 const holder=db.$transaction(async tx=>{await tx.$executeRaw`SELECT id FROM commercial_documents WHERE id=${a.id}::uuid FOR UPDATE`;held.resolve();await release.promise},{timeout:10000})
 await held.promise
 const write=other.$transaction(async tx=>{const pid=await tx.$queryRaw`SELECT pg_backend_pid() AS pid`;attempt.resolve(pid[0].pid);return tx.stockReservation.create({data})},{timeout:10000})
 const pid=await attempt.promise
 let waiting=false
 try{
  for(let checks=0;checks<100&&!waiting;checks++){
   const [state]=await db.$queryRaw`SELECT wait_event_type FROM pg_stat_activity WHERE pid=${pid}`
   waiting=state?.wait_event_type==='Lock'
   if(!waiting)await new Promise(r=>setTimeout(r,10))
  }
  assert.equal(waiting,true,'reservation insert must wait on its line owner parent lock')
 }finally{release.resolve()}
 await holder;await write
 assert.equal(await db.stockReservation.count({where:{document_line_id:a.lines[0].id}}),1)
 // A line can itself move while the reservation waits for a parent lock.
 // Either serialize safely or roll one writer back; never certify the old owner.
 const movable=await make(),destination=await make(),moveHeld=deferred(),moveRelease=deferred()
 let revisionImmediatelyAfterMove
 const mover=db.$transaction(async tx=>{
  await tx.$executeRaw`SELECT id FROM commercial_documents WHERE id=${movable.id}::uuid FOR UPDATE`
  moveHeld.resolve();await moveRelease.promise
  await tx.commercialDocumentLine.update({where:{id:movable.lines[0].id},data:{document_id:destination.id}})
  revisionImmediatelyAfterMove=(await tx.commercialDocument.findUnique({where:{id:destination.id},select:{integration_revision:true}})).integration_revision
 },{timeout:10000}).then(()=>({ok:true}),error=>({error}))
 await moveHeld.promise
 const insertAttempt=deferred()
 const inserter=other.$transaction(async tx=>{
  const [connection]=await tx.$queryRaw`SELECT pg_backend_pid() AS pid`;insertAttempt.resolve(connection.pid)
  return tx.stockReservation.create({data:{...data,document_id:movable.id,document_line_id:movable.lines[0].id}})
 },{timeout:10000}).then(value=>({value}),error=>({error}))
 const insertPid=await insertAttempt.promise
 let moveWaiting=false
 try{
  for(let checks=0;checks<100&&!moveWaiting;checks++){
   const [state]=await db.$queryRaw`SELECT wait_event_type FROM pg_stat_activity WHERE pid=${insertPid}`
   moveWaiting=state?.wait_event_type==='Lock'
   if(!moveWaiting)await new Promise(r=>setTimeout(r,10))
  }
  assert.equal(moveWaiting,true)
 }finally{moveRelease.resolve()}
 const [moveResult,insertResult]=await Promise.all([mover,inserter])
 if(moveResult.ok&&insertResult.value)assert.notEqual(await revision(destination.id),revisionImmediatelyAfterMove,'reservation must invalidate its final line owner after a concurrent move')
 else assert.match(String((moveResult.error||insertResult.error)?.message),/deadlock|write conflict/i,'only a safely rolled-back concurrency conflict is accepted')
 const functionText=await db.$queryRaw`SELECT pg_get_functiondef('public.auna_reservation_revision_relation()'::regprocedure) AS body`
 assert.doesNotMatch(functionText[0].body,/SECURITY DEFINER|EXECUTE\s+(?!FUNCTION)/i)
})
