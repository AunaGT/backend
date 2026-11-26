const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto')
const {qaSchema,fixture,insertCase}=require('./helpers/cashDisputesQa.cjs')
const url=process.env.AUNA_CASH_DISPUTES_QA_URL
const storage=require('../src/modules/cash-closure/noticeEvidence'),evidence=require('../src/modules/cash-closure/disputes.evidence')
const {getDispute}=require('../src/modules/cash-closure/disputes.queries')
test('case evidence is stored privately once per attempt and only signed for its own case',{skip:!url,timeout:240000},async()=>{
 const {db}=await qaSchema(url),original={store:storage.storeEvidence,sign:storage.signStoredEvidence},stored=[]
 storage.storeEvidence=async(prefix,file)=>{const path=`${prefix}/${randomUUID()}.pdf`;stored.push({path,size:file.buffer.length});return {path,mimeType:'application/pdf',size:file.buffer.length}}
 storage.signStoredEvidence=async path=>({url:'https://signed.invalid/'+encodeURIComponent(path),expiresAt:'2026-11-25T12:01:00Z'})
 try{
  const f=await fixture(db),id=await insertCase(db,f,{claimed:'40.00'}),other=await insertCase(db,f,{claimed:'40.00'})
  const file={buffer:Buffer.from('%PDF-1.4 soporte'),originalname:'carta\u0000/banco.pdf',size:16},requestKey=randomUUID()
  const attach=raw=>db.$transaction(tx=>evidence.attachDisputeEvidence(tx,f.scope,id,raw))
  const first=await attach({file,requestKey})
  assert.deepEqual(await attach({file,requestKey}),first,'a lost response replays without a second upload');assert.equal(stored.length,1)
  assert.match(stored[0].path,new RegExp(`^${f.company.id}/disputes/${id}/`))
  await assert.rejects(attach({file:{...file,buffer:Buffer.from('otro')},requestKey}),{code:'DISPUTE_ATTEMPT_CONFLICT'})
  const item=first.history.find(e=>e.kind==='EVIDENCE')
  assert.equal(item.payload.fileName,'carta  banco.pdf');assert.equal(JSON.stringify(await getDispute(db,f.scope,id)).includes('/disputes/'),false,'the storage path is never published')
  assert.match((await evidence.signDisputeEvidence(db,f.scope,id,item.id)).url,/signed\.invalid/)
  await assert.rejects(evidence.signDisputeEvidence(db,f.scope,other,item.id),{status:404},'another case cannot sign this file')
  await assert.rejects(db.$transaction(tx=>evidence.attachDisputeEvidence(tx,{...f.scope,can:{read:true}},id,{file,requestKey:randomUUID()})),{status:403})
 }finally{Object.assign(storage,{storeEvidence:original.store,signStoredEvidence:original.sign});await db.$disconnect()}
})
