const test=require('node:test'),assert=require('node:assert/strict'),express=require('express'),http=require('node:http'),util=require('node:util')
const {withMocks}=require('./helpers/reportHarness.cjs')
const {fixture,scope,input,OWNER,BRANCH}=require('./helpers/integrationsDb')
const {draftFixture}=require('./helpers/integrationDraftDb')
test('real app isolates integration authentication and credential parser failures before global middleware',async()=>{
 const f=fixture(),created=await require('../src/modules/integrations/management').createCredential(f.db,scope,input)
 const settings=express.Router();settings.use('/settings/integrations',require('../src/modules/integrations/routes').createManagementRouter({db:f.db,auth:(_r,_s,n)=>n(),scope:()=>scope,allowedOrigins:['http://localhost:8080']}))
 await withMocks({[require.resolve('../src/routes')]:settings,[require.resolve('../src/modules/users/routes')]:express.Router(),[require.resolve('../src/models/prisma')]:{prisma:f.db,prismaTransaction:f.db}},require.resolve('../app'),async app=>{
  const server=http.createServer(app),logs=[],old=console.error;console.error=(...v)=>logs.push(util.inspect(v));await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`
  try{
   assert.equal((await fetch(base+'/api/integrations/v1/branches',{headers:{Cookie:'auth=erp-session'}})).status,401)
   const origin=await fetch(base+'/api/integrations/v1/branches',{headers:{Origin:'https://untrusted.test',Authorization:'Bearer '+created.apiKey}});assert.equal(origin.status,403);assert.equal(origin.headers.get('access-control-allow-origin'),null)
   const result=await fetch(base+'/api/integrations/v1/branches',{headers:{Authorization:'Bearer '+created.apiKey}})
   // The fixture has no SQL quota store: fail closed before any catalog data.
   assert.equal(result.status,503);assert.doesNotMatch(await result.text(),/Principal|secret_hash|auna_live_/)
   for(const [type,body,status]of [['application/json','{"name":"SENSITIVE-MARKER",',400],['application/json',JSON.stringify({name:'SENSITIVE-MARKER'+'x'.repeat(17000)}),413],['application/x-www-form-urlencoded','name=SENSITIVE-MARKER',415]]){
    const r=await fetch(base+'/api/settings/integrations',{method:'POST',headers:{'Content-Type':type,Origin:'http://localhost:8080'},body});assert.equal(r.status,status);assert.doesNotMatch(await r.text(),/SENSITIVE-MARKER/)
   }
   assert.doesNotMatch(logs.join(''),/SENSITIVE-MARKER/)
  }finally{console.error=old;server.closeAllConnections();await new Promise(r=>server.close(r))}
 })
})
test('real app parses commercial POST only after key authentication and quota, without global error leakage',async()=>{
 const f=draftFixture(),created=await require('../src/modules/integrations/management').createCredential(f.db,scope,{...input,scopes:['quotes.create_draft']})
 // Quota SQL is intentionally successful only for this controlled database double.
 f.db.$queryRaw=async()=>[{count:1}]
 await withMocks({[require.resolve('../src/routes')]:express.Router(),[require.resolve('../src/modules/users/routes')]:express.Router(),[require.resolve('../src/models/prisma')]:{prisma:f.db,prismaTransaction:f.db}},require.resolve('../app'),async app=>{
  const server=http.createServer(app),logs=[],old=console.error;console.error=(...v)=>logs.push(util.inspect(v));await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}/api/integrations/v1/quotes`,headers={Authorization:'Bearer '+created.apiKey,'Content-Type':'application/json','Idempotency-Key':'actual-app-post-12345'}
  try{
   for(const [body,status] of [['{"SENSITIVE-MARKER":',400],[' '.repeat(65537),413]]){const result=await fetch(url,{method:'POST',headers,body});assert.equal(result.status,status);assert.doesNotMatch(await result.text(),/SENSITIVE-MARKER|SyntaxError/)}
   const result=await fetch(url,{method:'POST',headers,body:JSON.stringify({branchId:BRANCH,customerId:OWNER,items:[{productId:OWNER,quantity:'1'}]})});assert.equal(result.status,201);assert.equal((await result.json()).status,'DRAFT');assert.equal(f.docs.length,1)
   assert.doesNotMatch(logs.join(''),/SENSITIVE-MARKER/)
  }finally{console.error=old;server.closeAllConnections();await new Promise(r=>server.close(r))}
 })
})
test('forwarded headers do not make an untrusted production peer HTTPS',()=>{
 const {secureTransport}=require('../src/modules/integrations/httpBoundary'),env=process.env.NODE_ENV,proxy=process.env.INTEGRATIONS_TRUSTED_PROXY_IPS
 try{process.env.NODE_ENV='production';delete process.env.INTEGRATIONS_TRUSTED_PROXY_IPS;assert.equal(secureTransport({socket:{remoteAddress:'127.0.0.1'},secure:true}),false);process.env.INTEGRATIONS_TRUSTED_PROXY_IPS='10.0.0.1';assert.equal(secureTransport({socket:{remoteAddress:'10.0.0.1'},secure:true}),true);assert.equal(secureTransport({socket:{remoteAddress:'10.0.0.2'},secure:true}),false)}finally{if(env===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=env;if(proxy===undefined)delete process.env.INTEGRATIONS_TRUSTED_PROXY_IPS;else process.env.INTEGRATIONS_TRUSTED_PROXY_IPS=proxy}
})
test('an untrusted forwarded IP cannot bypass the preauthentication bucket',()=>{
 const {preAuthKey}=require('../src/modules/integrations/httpBoundary')
 assert.equal(preAuthKey({socket:{remoteAddress:'127.0.0.1'},ip:'203.0.113.1'}),preAuthKey({socket:{remoteAddress:'127.0.0.1'},ip:'203.0.113.2'}))
})
