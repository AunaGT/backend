const {performance}=require('node:perf_hooks')
const requests=new WeakMap()
const labels=new Set(['context','unit_prepare','sale_tx','sale_response','ticket_snapshot','ticket_events'])
function requestTiming(req,res,next){
 if(process.env.PERFORMANCE_TIMING!=='true')return next()
 const data={start:performance.now(),phases:{}};requests.set(req,data)
 res.once('finish',()=>{
  const route=typeof req.route?.path==='string'?req.route.path:'unmatched'
  console.info('[performance]',{method:req.method,route,status:res.statusCode,totalMs:performance.now()-data.start,phases:data.phases})
  requests.delete(req)
 })
 next()
}
async function measureRequestPhase(req,label,run){
 const data=requests.get(req)
 if(!data||!labels.has(label))return run()
 const start=performance.now()
 try{return await run()}finally{data.phases[label]=(data.phases[label]||0)+performance.now()-start}
}
module.exports={requestTiming,measureRequestPhase}
