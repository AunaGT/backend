const {prisma}=require('../../models/prisma')
const {disputeScope}=require('./disputes.access')
const queries=require('./disputes.queries'),{fail}=require('./disputes.domain')
const posting=require('../../services/accounting/cashDisputePosting')
const pending='Por el momento puedes consultar los expedientes. El registro de nuevos reclamos y resoluciones todavía no está habilitado.'
const run=(action,work)=>async(req,res,next)=>{try{res.set('Cache-Control','private, no-store');res.json(await work(req,disputeScope(req,action)))}catch(error){next(error)}}
const closed=()=>fail('DISPUTE_COMMANDS_UNAVAILABLE',pending,409)
exports.capabilities=run('capabilities',async(req,scope)=>{
  const available=await queries.disputesAvailable(prisma),open=available&&require('./disputes.release').commandsReleased()
  return {available,commandsAvailable:open,reason:open?null:pending,evidenceUpload:open&&(scope.can.manage||scope.can.movements)&&await require('./disputes.evidence').evidenceAvailable(),
    can:open?scope.can:{...scope.can,manage:false,movements:false,resolve:false,charge:false,adjust:false,post:false}}
})
exports.list=run('read',(req,s)=>queries.listDisputes(prisma,s,req.query))
exports.origin=run('read',(req,s)=>queries.originContext(prisma,s,req.params.eventId))
exports.detail=run('read',async(req,s)=>{
  const doc=await queries.getDispute(prisma,s,req.params.caseId)
  const open=require('./disputes.release').commandsReleased()
  return {...doc,can:open?{...doc.can,adjust:s.can.adjust,post:s.can.post}:{...doc.can,manage:false,movements:false,resolve:false,charge:false,adjust:false,post:false},accounting:await posting.inspectDisputeAccounting(prisma,s,doc.id)}
})
exports.postingPreview=run('read',(req,s)=>posting.inspectDisputeAccounting(prisma,s,req.params.caseId))
// Los comandos llaman a sus servicios reales detrás de un solo interruptor; cerrado, no abren transacción.
const release=require('./disputes.release')
const write=fn=>prisma.$transaction(fn,{timeout:30000,maxWait:10000})
const command=(action,work)=>run(action,async(req,s)=>{
  if(!release.commandsReleased()||!await queries.disputesAvailable(prisma))closed()
  return work(req,s)
})
const flow=()=>require('./disputes')
exports.create=command('manage',(req,s)=>write(tx=>flow().createDispute(tx,s,req.body||{})))
exports.preview=command('read',(req,s)=>flow().previewDisputeAction(prisma,s,req.params.caseId,req.body||{}))
exports.propose=command('manage',(req,s)=>write(tx=>flow().proposeDisputeAction(tx,s,req.params.caseId,req.body||{})))
exports.decide=command('resolve',(req,s)=>write(tx=>flow().decideDisputeProposal(tx,s,req.params.caseId,req.params.proposalId,req.body||{})))
exports.confirmEffect=command('movements',(req,s)=>write(tx=>require('./disputes.effects').confirmDisputeEffect(tx,s,req.params.caseId,req.body||{})))
exports.legacyDeduction=command('movements',(req,s)=>write(tx=>require('./disputes.settlements').linkLegacyDeduction(tx,s,req.params.caseId,req.body||{})))
exports.attachEvidence=command('read',(req,s)=>write(tx=>require('./disputes.evidence').attachDisputeEvidence(tx,s,req.params.caseId,{file:req.file,requestKey:req.body?.requestKey})))
// Abrir un soporte es consulta: no depende de que los comandos estén liberados.
exports.evidence=run('read',(req,s)=>require('./disputes.evidence').signDisputeEvidence(prisma,s,req.params.caseId,req.params.evidenceId))
// El registro contable tardío exige autoridad contable propia, no la de resolver disputas.
exports.post=command('read',(req,s)=>{
  if(!s.can.post)fail('DISPUTE_FORBIDDEN','Necesitas permiso contable para contabilizar fuentes pendientes',403)
  return write(tx=>posting.postDisputeChain(tx,s,req.params.caseId,{accountingDateBySource:req.body?.accountingDateBySource||{}}))
})
