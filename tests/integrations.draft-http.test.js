const test=require('node:test'),assert=require('node:assert/strict'),express=require('express'),{gzipSync}=require('node:zlib')
const {draftFixture}=require('./helpers/integrationDraftDb'),{scope,input,OWNER,BRANCH}=require('./helpers/integrationsDb')
async function setup(t,scopes=['quotes.create_draft','quotes.read']){
 const f=draftFixture(),now=new Date(),created=await require('../src/modules/integrations/management').createCredential(f.db,scope,{...input,scopes},now)
 const app=express();let global=0,quota=0
 app.use('/api/integrations/v1',require('../src/modules/integrations/httpBoundary').createExternalBoundary(),require('../src/modules/integrations/routes').createExternalRouter({db:f.db,now:()=>now,consumeQuota:async()=>{quota++}}))
 app.use(express.json(),(_r,res)=>{global++;res.sendStatus(599)})
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>new Promise(r=>server.close(r)))
 return{...f,url:`http://127.0.0.1:${server.address().port}/api/integrations/v1`,headers:{Authorization:'Bearer '+created.apiKey,'Content-Type':'application/json','Idempotency-Key':'request-http-123456'},body:JSON.stringify({branchId:BRANCH,customerId:OWNER,items:[{productId:OWNER,quantity:'1'}]}),counts:()=>({global,quota})}
}
test('authorized POST creates once; replay is 200 with no post-commit audit',async t=>{
 const f=await setup(t),post=()=>fetch(f.url+'/quotes',{method:'POST',headers:f.headers,body:f.body})
 const first=await post();assert.equal(first.status,201);const receipt=await first.json();assert.equal(receipt.total,'12.50')
 const replay=await post();assert.equal(replay.status,200);assert.deepEqual(await replay.json(),receipt)
 assert.equal(f.docs.length,1);assert.equal(f.events.filter(e=>e.action==='CREATE_DRAFT').length,1);assert.equal(f.events.filter(e=>e.action==='USE').length,1)
 assert.deepEqual(f.counts(),{global:0,quota:2})
 assert.equal((await fetch(f.url+'/quotes/'+receipt.id+'?include=customer',{headers:f.headers})).status,400)
})
test('JSON limits, compression, conflicting branch and unknown authority never reach global parser',async t=>{
 const f=await setup(t)
 for(const [body,headers,status] of [['{"private-marker":',{},400],[' '.repeat(65537),{},413],[gzipSync(f.body),{'Content-Encoding':'gzip'},415],[f.body,{'X-Branch-Id':'foreign'},403]]){
  const response=await fetch(f.url+'/quotes',{method:'POST',headers:{...f.headers,...headers},body});assert.equal(response.status,status);assert.doesNotMatch(await response.text(),/private-marker|Prisma|SyntaxError/)
 }
 assert.equal(f.docs.length,0);assert.equal(f.counts().global,0)
})
test('read-only scope blocks POST before body parsing and unsupported methods stay closed',async t=>{
 const f=await setup(t,['products.read'])
 assert.equal((await fetch(f.url+'/quotes',{method:'POST',headers:f.headers,body:'invalid'})).status,403)
 const denied=await fetch(f.url+'/quotes',{method:'DELETE',headers:f.headers});assert.equal(denied.status,405);assert.equal(denied.headers.get('allow'),'GET, POST')
 assert.equal((await fetch(f.url+'/quotes',{headers:f.headers})).status,403)
})
