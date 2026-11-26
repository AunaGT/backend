const {prisma}=require('../../models/prisma')
const {correctionScope}=require('./corrections.access'),flow=require('./corrections')
const run=(action,work)=>async(req,res,next)=>{
  try{
    res.set('Cache-Control','private, no-store')
    const scope=correctionScope(req,action)
    res.json(await work(req,scope))
  }catch(error){next(error)}
}
const write=work=>prisma.$transaction(work,{timeout:30000,maxWait:10000})
exports.context=run('read',(req,s)=>flow.correctionContext(prisma,s,req.params.id))
exports.list=run('read',(req,s)=>flow.listCorrections(prisma,s,req.params.id,req.query))
exports.detail=run('read',(req,s)=>flow.getCorrection(prisma,s,req.params.id,req.params.correctionId))
exports.preview=run('propose',(req,s)=>flow.previewCorrection(prisma,s,req.params.id,req.body))
exports.propose=run('propose',(req,s)=>write(tx=>flow.proposeCorrection(tx,s,req.params.id,req.body)))
exports.decide=run('review',(req,s)=>write(tx=>flow.decideCorrection(tx,s,req.params.id,req.params.correctionId,req.body)))
exports.cancel=run('propose',(req,s)=>write(tx=>flow.cancelCorrection(tx,s,req.params.id,req.params.correctionId,req.body)))
