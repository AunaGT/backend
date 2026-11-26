const test=require('node:test'),assert=require('node:assert/strict')
const {spawn}=require('node:child_process'),{once}=require('node:events')
const fs=require('node:fs'),path=require('node:path'),os=require('node:os')
const root=path.resolve(__dirname,'..'),sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))
async function fixture(t,npm=false){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'auna-document-start-'))
  fs.mkdirSync(path.join(dir,'scripts'))
  const runner=path.join(root,'scripts/dev-server.js')
  if(fs.existsSync(runner))fs.copyFileSync(runner,path.join(dir,'scripts/dev-server.js'))
  for(const [file,name] of [['index.js','api'],['scripts/document-worker.js','documents']])fs.writeFileSync(path.join(dir,file),`
    const fs=require('node:fs'),path=require('node:path'),root=${JSON.stringify(dir)};
    const timer=setInterval(()=>{},1000);
    fs.writeFileSync(path.join(root,'${name}.ready'),JSON.stringify({pid:process.pid,parent:process.ppid}));
    process.on('SIGTERM',()=>{clearInterval(timer);setTimeout(()=>{fs.writeFileSync(path.join(root,'${name}.stopped'),'drained');process.exit(0)},40)});
  `)
  fs.copyFileSync(path.join(root,'package.json'),path.join(dir,'package.json'))
  fs.copyFileSync(path.join(root,'nodemon.json'),path.join(dir,'nodemon.json'))
  const child=spawn(npm?'npm':process.execPath,npm?['run','dev']:['scripts/dev-server.js'],{cwd:dir,detached:true,env:{...process.env,PATH:`${path.join(root,'node_modules/.bin')}:${process.env.PATH}`},stdio:['ignore','pipe','pipe']})
  let output='';child.stdout.on('data',s=>output+=s);child.stderr.on('data',s=>output+=s)
  t.after(()=>{try{process.kill(-child.pid,'SIGKILL')}catch{}fs.rmSync(dir,{recursive:true,force:true})})
  const read=name=>{try{return JSON.parse(fs.readFileSync(path.join(dir,`${name}.ready`)))}catch{return null}}
  async function ready(old){for(let i=0;i<150;i++){if(read('api')&&read('documents')&&(!old||read('api').pid!==old.api.pid&&read('documents').pid!==old.documents.pid))return;if(child.exitCode!==null)break;await sleep(30)}assert.fail(`El arranque debe iniciar API y generador de PDF: ${output}`)}
  return{dir,child,read,ready}
}
test('the normal development command starts and safely restarts both API and document worker',{timeout:15000},async t=>{
  const h=await fixture(t,true);await h.ready()
  assert.notEqual(h.read('api').pid,h.read('documents').pid)
  assert.equal(h.read('api').parent,h.read('documents').parent)
  const old={api:h.read('api'),documents:h.read('documents')}
  fs.appendFileSync(path.join(h.dir,'index.js'),'\n// application update\n')
  await h.ready(old)
  for(const name of ['api','documents']){
    assert.equal(fs.readFileSync(path.join(h.dir,`${name}.stopped`),'utf8'),'drained')
    fs.unlinkSync(path.join(h.dir,`${name}.stopped`))
  }
  process.kill(h.read('api').parent,'SIGTERM')
  for(let i=0;i<100;i++){if(fs.existsSync(path.join(h.dir,'api.stopped'))&&fs.existsSync(path.join(h.dir,'documents.stopped')))return;await sleep(20)}
  assert.fail('El cierre debe esperar ambos servicios')
})
test('stopping the supervisor lets both services finish before it exits',{timeout:10000},async t=>{
  const h=await fixture(t);await h.ready();const ended=once(h.child,'exit');h.child.kill('SIGTERM')
  assert.equal((await ended)[0],0)
  for(const name of ['api','documents'])assert.equal(fs.readFileSync(path.join(h.dir,`${name}.stopped`),'utf8'),'drained')
})
test('a dead document worker stops the API instead of leaving silent unprocessed PDFs',{timeout:10000},async t=>{
  const h=await fixture(t);await h.ready();const ended=once(h.child,'exit');process.kill(h.read('documents').pid,'SIGKILL')
  assert.equal((await ended)[0],1)
  assert.equal(fs.readFileSync(path.join(h.dir,'api.stopped'),'utf8'),'drained')
})
