const test=require('node:test'),assert=require('node:assert/strict'),express=require('express'),{fixture,scope,input,BRANCH}=require('./helpers/integrationsDb')
async function setup(t){
 const f=fixture(),now=new Date(),created=await require('../src/modules/integrations/management').createCredential(f.db,scope,input,now)
 const app=express();app.use('/api/integrations/v1',require('../src/modules/integrations/httpBoundary').createExternalBoundary(),require('../src/modules/integrations/routes').createExternalRouter({db:f.db,now:()=>now,consumeQuota:async()=>{}}))
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>new Promise(r=>server.close(r)))
 return{...f,created,url:`http://127.0.0.1:${server.address().port}/api/integrations/v1`,headers:{Authorization:'Bearer '+created.apiKey}}
}
test('external routes reject sessions, writes, browser origins and scope escalation',async t=>{
 const f=await setup(t)
 assert.equal((await fetch(f.url+'/branches',{headers:{Cookie:'auth=x'}})).status,401)
 assert.equal((await fetch(f.url+'/branches',{headers:f.headers})).status,200)
 assert.equal((await fetch(f.url+'/prices?productIds=x&branchId='+BRANCH,{headers:f.headers})).status,403)
 assert.equal((await fetch(f.url+'/products',{method:'POST',headers:f.headers})).status,405)
 assert.equal((await fetch(f.url+'/branches',{headers:{...f.headers,Origin:'https://foreign.test'}})).status,403)
 assert.equal((await fetch(f.url+'/branches',{headers:{...f.headers,'X-Company-Id':'foreign'}})).status,403)
 assert.equal((await fetch(f.url+'/branches?apiKey='+f.created.apiKey,{headers:f.headers})).status,400)
})
test('a usage audit failure withholds data and unexpected errors never echo secrets',async t=>{
 const f=await setup(t);f.breakAudit()
 const r=await fetch(f.url+'/branches',{headers:f.headers}),body=await r.text()
 assert.equal(r.status,503);assert.doesNotMatch(body,/audit failure|auna_live_|Principal/)
 assert.match(r.headers.get('cache-control'),/no-store/)
})
test('management rejects missing cookie origin and key authentication, and shows secrets only at creation',async t=>{
 const f=fixture(),app=express();app.use(express.json());app.use('/settings',require('../src/modules/integrations/routes').createManagementRouter({db:f.db,scope:()=>scope,auth:(_r,_s,n)=>n(),allowedOrigins:['http://erp.test']}))
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>new Promise(r=>server.close(r)));const url=`http://127.0.0.1:${server.address().port}/settings`
 for(const headers of [{Cookie:'auth=x'},{Origin:'https://foreign.test'},{Authorization:'Bearer auna_live_fake'}])assert.equal((await fetch(url,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(input)})).status,403)
 const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json',Origin:'http://erp.test'},body:JSON.stringify(input)});assert.equal(r.status,201);assert.match((await r.json()).apiKey,/^auna_live_/)
 const list=await (await fetch(url)).json();assert.doesNotMatch(JSON.stringify(list),/secret_hash|auna_live_|apiKey/)
})
test('management pause and usage routes enforce bodies, read permissions and tenant boundaries',async t=>{
 const f=fixture(),now=new Date(),m=require('../src/modules/integrations/management'),key=await m.createCredential(f.db,scope,input,now)
 let requestScope=scope
 f.db.$queryRaw=async()=>[]
 const app=express();app.use(express.json());app.use('/settings',require('../src/modules/integrations/routes').createManagementRouter({db:f.db,scope:()=>requestScope,now:()=>now,auth:(_r,_s,next)=>next(),allowedOrigins:['http://erp.test']}))
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>new Promise(r=>server.close(r)))
 const url=`http://127.0.0.1:${server.address().port}/settings`,headers={'Content-Type':'application/json',Origin:'http://erp.test'}
 const post=async(action,body={})=>fetch(url+'/'+key.credential.id+'/'+action,{method:'POST',headers,body:JSON.stringify(body)})
 for(const body of [[],{pausedAt:'injected'}])assert.equal((await post('pause',body)).status,400)
 assert.equal((await post('pause')).status,200)
 assert.equal((await (await fetch(url+'?status=PAUSED')).json()).items[0].id,key.credential.id)
 const data=await (await fetch(url+'/'+key.credential.id+'/usage?period=24h')).json();assert.equal(data.total,0);assert.equal(data.errorRate,null)
 assert.equal((await fetch(url+'/usage?period=7d&credentialId='+key.credential.id)).status,400)
 requestScope={...scope,isAdmin:false,permissions:['integrations.view']}
 assert.equal((await fetch(url+'/usage?period=7d')).status,200)
 assert.equal((await post('resume')).status,403)
 requestScope=scope;assert.equal((await post('resume')).status,200)
 assert.equal(f.events.filter(e=>e.action==='PAUSE').length,1);assert.equal(f.events.filter(e=>e.action==='RESUME').length,1)
})
