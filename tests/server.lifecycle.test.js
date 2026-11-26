const test=require('node:test'),assert=require('node:assert/strict')
const {spawn}=require('node:child_process'),{once}=require('node:events')
const http=require('node:http'),fs=require('node:fs'),os=require('node:os'),path=require('node:path')
const root=path.resolve(__dirname,'..')
function waitForMessage(child,predicate){
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>finish(new Error('El servidor de prueba no respondió a tiempo')),10000)
    const message=value=>{if(predicate(value))finish(null,value)},exit=()=>finish(new Error('El servidor terminó antes de responder'))
    function finish(error,value){clearTimeout(timer);child.off('message',message);child.off('exit',exit);error?reject(error):resolve(value)}
    child.on('message',message);child.once('exit',exit)
  })
}
function request(port){return new Promise(resolve=>{
  const req=http.get({hostname:'127.0.0.1',port,path:'/slow',agent:false},res=>{let body='';res.setEncoding('utf8');res.on('data',chunk=>body+=chunk);res.on('end',()=>resolve({status:res.statusCode,body}))})
  req.on('error',error=>resolve({error:error.code}))
})}
const fixture=`
const http=require('node:http'),path=require('node:path'),root=${JSON.stringify(root)};
let disconnected=false;
const stub=(file,exports)=>{const id=require.resolve(path.join(root,file));require.cache[id]={id,filename:id,loaded:true,exports}};
stub('src/config/loadEnv.js',{});
stub('src/models/prisma.js',{disconnectPrisma:async()=>{disconnected=true;process.send({type:'disconnected'})}});
for(const [file,name] of [['commercialDocumentScheduler','startCommercialDocumentScheduler'],['couponAssetCleanup','startCouponAssetCleanup'],['integrationAuditCleanup','startIntegrationAuditCleanup'],['appointmentAutoClose','startAppointmentAutoClose'],['saleStockAlerts','startSaleStockAlerts']])stub('src/jobs/'+file+'.js',{[name]:()=>{}});
const server=http.createServer((req,res)=>{process.send({type:'request'});process.once('message',()=>res.end(disconnected?'BASE_CERRADA_ANTES_DE_RESPONDER':'respuesta completa'))});
const close=server.close.bind(server);server.close=(cb)=>{process.send({type:'draining'});return close(cb)};
stub('app.js',{listen:(port,callback)=>{server.listen(0,'127.0.0.1',()=>{callback();process.send({type:'ready',port:server.address().port})});return server}});
require(path.join(root,'index.js'));
`
for(const signal of ['SIGUSR2','SIGTERM'])test(`${signal} lets an active HTTP response finish before disconnecting and exiting`,{timeout:20000},async t=>{
  const child=spawn(process.execPath,['-e',fixture],{cwd:root,env:{...process.env,NODE_ENV:'development',PORT:'0'},stdio:['ignore','pipe','pipe','ipc']})
  t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL')})
  const ready=await waitForMessage(child,m=>m.type==='ready'),received=waitForMessage(child,m=>m.type==='request')
  const response=request(ready.port);await received
  const drain=waitForMessage(child,m=>m.type==='draining').then(()=>true,()=>false)
  const ended=once(child,'exit');child.kill(signal)
  if(await drain)child.send('finish')
  assert.deepEqual(await response,{status:200,body:'respuesta completa'})
  await ended
})
test('development restarts for application changes and ignores tests and generated artifacts',{timeout:20000},async t=>{
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'auna-dev-watch-')),state=path.join(folder,'.boot-state')
  for(const dir of ['src','tests','files','prisma'])fs.mkdirSync(path.join(folder,dir))
  fs.writeFileSync(path.join(folder,'src/route.js'),"module.exports='uno'\n")
  fs.writeFileSync(path.join(folder,'tests/noise.test.js'),'// inicial\n')
  fs.writeFileSync(path.join(folder,'index.js'),`const fs=require('node:fs'),path=require('node:path'),http=require('node:http');const file=path.join(__dirname,'.boot-state');const count=fs.existsSync(file)?JSON.parse(fs.readFileSync(file)).count+1:1;const value=require('./src/route');const server=http.createServer((req,res)=>res.end(value));server.listen(0,'127.0.0.1',()=>fs.writeFileSync(file,JSON.stringify({count,port:server.address().port})));require(${JSON.stringify(path.join(root,'src/server/shutdown.js'))}).installServerShutdown(server,async()=>{});`)
  const config=path.join(root,'nodemon.json'),args=[require.resolve('nodemon/bin/nodemon.js'),'--cwd',folder,'--delay','100ms']
  if(fs.existsSync(config))args.push('--config',config)
  args.push('index.js')
  const child=spawn(process.execPath,args,{cwd:folder,detached:true,stdio:['ignore','pipe','pipe']})
  t.after(()=>{try{process.kill(-child.pid,'SIGKILL')}catch{}fs.rmSync(folder,{recursive:true,force:true})})
  const sleep=ms=>new Promise(r=>setTimeout(r,ms)),read=()=>{try{return JSON.parse(fs.readFileSync(state))}catch{return null}}
  async function boot(count){for(let i=0;i<100;i++){const s=read();if(s?.count>=count)return s;await sleep(50)}throw Error('El servidor vigilado no inició')}
  await boot(1);await sleep(350)
  fs.appendFileSync(path.join(folder,'tests/noise.test.js'),'// otra prueba\n')
  fs.writeFileSync(path.join(folder,'files/generated.json'),'{}')
  fs.writeFileSync(path.join(folder,'prisma/generated.js'),'// generado\n')
  await sleep(700);assert.equal(read().count,1,'editar pruebas o archivos generados no debe reiniciar la API')
  fs.writeFileSync(path.join(folder,'src/route.js'),"module.exports='dos'\n")
  const second=await boot(2);assert.equal(second.count,2);assert.deepEqual(await request(second.port),{status:200,body:'dos'})
})
