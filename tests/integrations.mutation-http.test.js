const test=require('node:test'),assert=require('node:assert/strict'),express=require('express'),{gzipSync}=require('node:zlib')
const {draftFixture}=require('./helpers/integrationDraftDb'),{scope,input,OWNER,BRANCH}=require('./helpers/integrationsDb')
async function setup(t,scopes=['quotes.read','quotes.create_draft','quotes.update_draft','quotes.cancel_draft']){
 const f=draftFixture(),now=new Date(),created=await require('../src/modules/integrations/management').createCredential(f.db,scope,{...input,scopes},now)
 const app=express();let parsedGlobally=0,quota=0
 app.use('/api/integrations/v1',require('../src/modules/integrations/httpBoundary').createExternalBoundary(),require('../src/modules/integrations/routes').createExternalRouter({db:f.db,now:()=>now,consumeQuota:async()=>{quota++}}))
 app.use(express.json(),(_req,res)=>{parsedGlobally++;res.sendStatus(599)})
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>new Promise(r=>server.close(r)))
 const url=`http://127.0.0.1:${server.address().port}/api/integrations/v1`,headers={Authorization:'Bearer '+created.apiKey,'Content-Type':'application/json','Idempotency-Key':'mutation-http-123456'}
 const doc={id:OWNER,reference:'Q-QA-000001',branch_id:BRANCH,branch:{company_id:scope.companyId},doc_type:'QUOTE',status:'DRAFT',sales_channel:'ONLINE',payment_condition:'CASH',discount_total:'0',total:'12.50',subtotal:'12.50',customer_contact_id:OWNER,integration_revision:BRANCH,created_at:now,updated_at:now,lines:[],notes:null}
 f.docs.push(doc);f.operations.push({company_id:scope.companyId,integration_id:created.credential.integrationId,type:'QUOTE',document_id:OWNER,branch_id:BRANCH,currency_code:'GTQ',document:doc})
 return{...f,url,headers,path:'/quotes/'+OWNER,etag:`"auna-draft-v1:${BRANCH}"`,counts:()=>({parsedGlobally,quota})}
}
test('GET has a strong ETag; PATCH and replay return 200 with one atomic mutation audit',async t=>{
 const f=await setup(t),read=await fetch(f.url+f.path,{headers:f.headers}),dto=await read.json()
 assert.equal(read.headers.get('etag'),f.etag);assert.equal(dto.version,'auna-draft-v1:'+BRANCH)
 const headers={...f.headers,'If-Match':f.etag},body=JSON.stringify({notes:'hello'})
 const patch=await fetch(f.url+f.path,{method:'PATCH',headers,body}),receipt=await patch.json()
 assert.equal(patch.status,200);assert.equal(patch.headers.get('etag'),`"${receipt.version}"`);assert.notEqual(patch.headers.get('etag'),f.etag)
 const replay=await fetch(f.url+f.path,{method:'PATCH',headers,body});assert.equal(replay.status,200);assert.deepEqual(await replay.json(),receipt)
 assert.equal(f.events.filter(e=>e.action==='UPDATE_DRAFT').length,1);assert.equal(f.events.filter(e=>e.action==='USE').length,2)
 assert.equal(f.counts().parsedGlobally,0);assert.doesNotMatch(JSON.stringify(receipt),/hello|notes|customer|secret/)
})
test('missing precondition is 428; malformed or stale version is 412 and each failure is audited once',async t=>{
 const f=await setup(t),body='{"notes":"safe"}'
 for(const [version,status,code] of [[undefined,428,'PRECONDITION_REQUIRED'],['*',412,'VERSION_CONFLICT'],['W/'+f.etag,412,'VERSION_CONFLICT'],[`"auna-draft-v1:${OWNER}"`,412,'VERSION_CONFLICT']]){
  const response=await fetch(f.url+f.path,{method:'PATCH',headers:{...f.headers,...(version?{'If-Match':version}:{})},body})
  assert.equal(response.status,status);assert.equal((await response.json()).error.code,code)
 }
 assert.equal(f.events.length,5);assert.ok(f.events.slice(1).every(e=>e.action==='USE'&&e.route==='/quotes/:id'))
 assert.equal(f.mutations.length,0)
})
test('cancel only accepts POST with empty JSON; methods advertise exact Allow',async t=>{
 const f=await setup(t),headers={...f.headers,'If-Match':f.etag},path=f.url+f.path+'/cancel'
 const invalid=await fetch(path,{method:'POST',headers,body:'{"notes":null}'});assert.equal(invalid.status,400)
 for(const [url,method,allow] of [[f.url+f.path,'DELETE','GET, PATCH'],[path,'PATCH','POST'],[path,'GET','POST'],[f.url+'/quotes','PATCH','GET, POST']]){
  const response=await fetch(url,{method,headers});assert.equal(response.status,405);assert.equal(response.headers.get('allow'),allow)
 }
 const response=await fetch(path,{method:'POST',headers,body:'{}'});assert.equal(response.status,200);const receipt=await response.json();assert.equal(receipt.status,'CANCELLED');assert.equal(response.headers.get('etag'),`"${receipt.version}"`)
 assert.equal(f.operations.length,1);assert.equal(f.events.at(-1).route,'/quotes/:id/cancel')
})
test('auth, quota, scope and Origin precede parsing; body and tenant boundaries stay closed',async t=>{
 const f=await setup(t,['quotes.read']),request=(path,headers,body)=>fetch(f.url+path,{method:'PATCH',headers,body})
 assert.equal((await request(f.path,f.headers,'invalid')).status,403)
 const noKey=await request(f.path,{'Content-Type':'application/json'},'invalid');assert.equal(noKey.status,401)
 const origin=await request(f.path,{...f.headers,Origin:'https://unsafe.test'},'invalid');assert.equal(origin.status,403)
 assert.equal(f.counts().quota,1);assert.equal(f.counts().parsedGlobally,0)
 const g=await setup(t),headers={...g.headers,'If-Match':g.etag}
 for(const [path,body,extra,status] of [[g.path,'x'.repeat(65537),{},413],[g.path,gzipSync('{}'),{'Content-Encoding':'gzip'},415],[g.path,'{"secret-marker":',{},400],[g.path+'?include=private','{}',{},400],[g.path,'{}',{'X-Branch-Id':OWNER},403],['/quotes/'+BRANCH,'{"notes":"hello"}',{},404]]){
  const response=await fetch(g.url+path,{method:'PATCH',headers:{...headers,...extra},body});assert.equal(response.status,status);assert.equal(response.headers.get('cache-control'),'no-store');assert.doesNotMatch(await response.text(),/secret-marker|Prisma|SyntaxError|stack|input_hash/)
 }
 assert.equal(g.counts().parsedGlobally,0);assert.equal(g.mutations.length,0)
})
test('a key without read cannot obtain version even from a malformed stored grant',async t=>{
 const f=await setup(t);f.rows[0].scopes=['quotes.update_draft','products.read']
 const response=await fetch(f.url+f.path,{headers:f.headers});assert.equal(response.status,403);assert.doesNotMatch(response.headers.get('etag')??'',/auna-draft-v1/);assert.doesNotMatch(await response.text(),/auna-draft-v1/)
})
test('successful mutation has no second mandatory audit transaction; SQL error status stays private',async t=>{
 const f=await setup(t),transaction=f.db.$transaction;let count=0
 f.db.$transaction=fn=>{if(++count>1)throw Error('no second transaction');return transaction(fn)}
 const response=await fetch(f.url+f.path,{method:'PATCH',headers:{...f.headers,'If-Match':f.etag},body:'{"notes":"hello"}'})
 assert.equal(response.status,200);assert.equal(count,1)
 const g=await setup(t);g.db.integrationDraftMutation.findFirst=async()=>{throw Object.assign(Error('synthetic private SQL marker'),{status:412})}
 const error=await fetch(g.url+g.path,{method:'PATCH',headers:{...g.headers,'If-Match':g.etag},body:'{"notes":"hello"}'})
 assert.equal(error.status,503);assert.doesNotMatch(await error.text(),/synthetic|private|SQL|412/);assert.equal(g.mutations.length,0)
})
