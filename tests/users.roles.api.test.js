const test=require('node:test'),assert=require('node:assert/strict'),express=require('express')
const {roleServiceFixture}=require('./helpers/roleServiceFixture.cjs')
test('active role HTTP handlers use revisions and return persisted DTOs',async t=>{
 const f=roleServiceFixture(),model=require.resolve('../src/models/prisma'),controller=require.resolve('../src/modules/users/adminController'),oldM=require.cache[model],oldC=require.cache[controller]
 require.cache[model]={exports:{prisma:f.db,prismaTransaction:f.db}};delete require.cache[controller]
 t.after(()=>{if(oldM)require.cache[model]=oldM;else delete require.cache[model];if(oldC)require.cache[controller]=oldC;else delete require.cache[controller]})
 const handlers=require(controller),app=express();app.use(express.json());app.use((req,res,next)=>{req.companyId='a';req.user={sub:'actor'};next()})
 app.get('/roles/:id',handlers.getRoleWithPermissions);app.post('/roles',handlers.createRole);app.put('/roles/:id',handlers.updateRole);app.delete('/roles/:id',handlers.deleteRole)
 app.use(require('../src/middlewares/errorHandler').errorHandler)
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>server.close())
 const send=(method,url,body)=>fetch(`http://127.0.0.1:${server.address().port}${url}`,{method,headers:{'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})})
 const missing=await send('PUT','/roles/101',{name:'Bodega',permissions:[]});assert.equal(missing.status,428)
 const response=await send('PUT','/roles/101',{name:'Bodega',permissions:['products.view'],expectedRevision:0}),saved=await response.json();assert.equal(response.status,200);assert.equal(saved.id,101);assert.equal(saved.revision,1)
 const conflict=await send('DELETE','/roles/101',{expectedRevision:0});assert.equal(conflict.status,409);assert.equal((await conflict.json()).code,'STALE_ROLE')
 const foreign=await send('GET','/roles/102');assert.equal(foreign.status,404)
 const created=await send('POST','/roles',{name:'Nuevo',permissions:[]});assert.equal(created.status,201)
})
test('mounted role routes preserve authentication, read-only access and module gates',async t=>{
 const f=roleServiceFixture(),model=require.resolve('../src/models/prisma'),oldM=require.cache[model]
 const paths=['../src/modules/users/routes','../src/modules/users/adminController','../src/modules/platform/service','../src/modules/platform/middleware'].map(require.resolve),previous=paths.map(p=>require.cache[p])
 let disabled=false
 f.db.companyModule={findMany:async()=>[{company_id:'a',module_code:'users',status:disabled?'DISABLED':'ACTIVE'}]}
 require.cache[model]={exports:{prisma:f.db,prismaTransaction:f.db}};paths.forEach(p=>delete require.cache[p])
 t.after(()=>{if(oldM)require.cache[model]=oldM;else delete require.cache[model];paths.forEach((p,i)=>{if(previous[i])require.cache[p]=previous[i];else delete require.cache[p]})})
 const router=require(paths[0]),{invalidateCompanyModules}=require(paths[2]),{crearToken}=require('../src/services/jwt')
 const app=express();app.use(express.json());app.use((req,res,next)=>{
  req.companyId='a';invalidateCompanyModules('a')
  const role=req.headers['x-qa-reader']?{id:101,name:'Lector',company_id:'a',permissions:[{permission:{code:'roles.view'}}]}:{id:73,name:'admin',company_id:null,system_key:'ADMIN',permissions:[]}
  req.sessionUser={id:'actor',role,user_companies:[{company_id:'a',status:'ACTIVE',role}]};next()
 });app.use('/api/auth',router);app.use(require('../src/middlewares/errorHandler').errorHandler)
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>server.close())
 const token=crearToken({id:'actor'}),send=(method,reader=false,auth=true)=>fetch(`http://127.0.0.1:${server.address().port}/api/auth/roles`,{method,headers:{'content-type':'application/json',...(auth?{authorization:`Bearer ${token}`}:{ }),...(reader?{'x-qa-reader':'1'}:{})},...(method==='POST'?{body:JSON.stringify({name:'Nuevo HTTP',permissions:[]})}:{})})
 assert.equal((await send('GET',false,false)).status,401)
 assert.equal((await send('GET',true)).status,200)
 assert.equal((await send('POST',true)).status,403)
 disabled=true;assert.equal((await send('POST')).status,403)
 disabled=false;assert.equal((await send('POST')).status,201)
})
