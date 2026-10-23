const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events'),fs=require('node:fs'),path=require('node:path')
const file=path.join(__dirname,'../src/utils/requestTiming.js'),api=()=>fs.existsSync(file)?require(file):{}
test('request timings isolate concurrent scopes and never include URL, IDs, tokens or business data',async()=>{
 assert.equal(typeof api().requestTiming,'function');const {requestTiming,measureRequestPhase}=api(),logs=[],oldLog=console.info,oldFlag=process.env.PERFORMANCE_TIMING
 process.env.PERFORMANCE_TIMING='true';console.info=(...args)=>logs.push(args)
 try{const a={method:'POST',url:'/sales/10000000-0000-4000-8000-000000000001?secret=token',headers:{authorization:'secret'},body:{customer:'Private'},route:{path:'/sales/:id'}},b={method:'GET',route:{path:'/products'}},ra=new EventEmitter(),rb=new EventEmitter();ra.statusCode=201;rb.statusCode=200
  requestTiming(a,ra,()=>{});requestTiming(b,rb,()=>{})
  let release;const pending=measureRequestPhase(a,'sale_tx',()=>new Promise(resolve=>{release=resolve}));await measureRequestPhase(b,'unit_prepare',async()=>{});release();await pending
  await assert.rejects(measureRequestPhase(a,'sale_response',async()=>{throw Error('private failure')}),/private failure/)
  ra.emit('finish');rb.emit('finish');assert.equal(logs.length,2)
  const one=logs[0][1],two=logs[1][1];assert.ok(one.phases.sale_tx>=0);assert.ok(one.phases.sale_response>=0);assert.equal(one.phases.unit_prepare,undefined);assert.ok(two.phases.unit_prepare>=0);assert.equal(two.phases.sale_tx,undefined)
  // Un fragmento numérico de UUID también puede aparecer en una duración de punto flotante.
  assert.doesNotMatch(JSON.stringify(logs),/token|secret|Private|10000000-0000-4000-8000-000000000001|private failure/)
 }finally{console.info=oldLog;if(oldFlag===undefined)delete process.env.PERFORMANCE_TIMING;else process.env.PERFORMANCE_TIMING=oldFlag}
})
test('timing disabled executes work normally with no emitted log or private labels',async()=>{
 assert.equal(typeof api().requestTiming,'function');const oldLog=console.info,oldFlag=process.env.PERFORMANCE_TIMING;let logs=0,called=false;delete process.env.PERFORMANCE_TIMING;console.info=()=>logs++
 try{const req={method:'POST'},res=new EventEmitter();api().requestTiming(req,res,()=>{called=true});assert.equal(await api().measureRequestPhase(req,'sale_tx',async()=>42),42);res.emit('finish');assert.equal(called,true);assert.equal(logs,0)}finally{console.info=oldLog;if(oldFlag!==undefined)process.env.PERFORMANCE_TIMING=oldFlag}
})
