const {spawn}=require('node:child_process')
const path=require('node:path')
const root=path.resolve(__dirname,'..'),children=new Set()
let stopping=false,exitCode=0,deadline

function finish(){
  if(stopping&&children.size===0){clearTimeout(deadline);process.exit(exitCode)}
}
function stop(code=0){
  if(stopping)return
  stopping=true;exitCode=code
  deadline=setTimeout(()=>{
    for(const child of children)child.kill('SIGKILL')
    process.exit(1)
  },35000)
  deadline.unref()
  for(const child of children)child.kill('SIGTERM')
  finish()
}
for(const signal of ['SIGINT','SIGTERM','SIGUSR2'])process.on(signal,()=>stop())
for(const script of ['index.js','scripts/document-worker.js']){
  const child=spawn(process.execPath,[script],{cwd:root,env:process.env,stdio:'inherit'})
  children.add(child)
  child.once('error',()=>{
    console.error(`[dev] No se pudo iniciar ${script}.`)
    children.delete(child);stop(1);finish()
  })
  child.once('exit',code=>{
    children.delete(child)
    if(!stopping){console.error(`[dev] ${script} se detuvo; cerrando ambos servicios.`);stop(code||1)}
    finish()
  })
}
