const {createHash}=require('node:crypto')
const {fail,uuid}=require('../validation')
const {operationScope,originPermission,resolveWorkstation,has}=require('../operations')
const {jobInput,eventInput,reprintInput}=require('./validation')
const {resolvePrintSource,authorizeSource}=require('./sources')
const {lockPrintBranding}=require('./branding')
const {fetchLogoForHttp}=require('../../../../utils/pdfBranding')
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
const source=row=>({kind:row.source_kind,id:row.source_id})
const dto=row=>({id:row.id,parentId:row.parent_id,source:source(row),workstationId:row.workstation_id,destinationName:row.route_snapshot?.destination?.name||null,state:row.state,document:row.document,pages:row.pages,createdAt:row.created_at,reason:row.reason})
const atomic=(db,run)=>db.$transaction(run,{timeout:20000,maxWait:10000})
async function lock(tx,scope,key){await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`print:${scope.companyId}:${scope.actorId}:${key}`},0))`}
async function ownJob(db,scope,id){
 const tenant=operationScope(scope);uuid(id,'jobId')
 const row=await db.hardwarePrintJob.findFirst({where:{...tenant,actor_id:scope.actorId,id}})
 if(!row)fail(404,'Trabajo no encontrado')
 await authorizeSource(db,scope,source(row));return row
}
async function routeFor(tx,scope,input,snapshot){
 if(!input.workstationId)return null
 const route=await resolveWorkstation(tx,scope,{workstationId:input.workstationId,purpose:input.source.kind==='SALE_TICKET'?'RECEIPT':'LABEL',...(snapshot.cashRegisterId?{cashRegisterId:snapshot.cashRegisterId}:{})})
 if(!route||input.destinationId&&route.destination?.id!==input.destinationId)fail(409,'El destino cambió. Actualiza el puesto o prepara un PDF sin equipo')
 if(!input.destinationId)return{...route,destination:null}
 const profile=route.destination.profile
 if((profile.copies??1)!==1||profile.offsetXMm||profile.offsetYMm)fail(409,'Este perfil altera copias o posición. Prepara PDF sin equipo o ajusta el perfil')
 if(input.source.kind==='SALE_TICKET'){
   if(profile.widthMm!==80)fail(409,'El ticket requiere ancho de 80 mm; usa PDF sin equipo para otro formato')
 }else{
   const {paper,design}=snapshot.prepared
   const dims=paper.format==='thermal'?[design.widthMm,design.heightMm]:paper.orientation==='landscape'?[paper.heightMm,paper.widthMm]:[paper.widthMm,paper.heightMm]
   const deviceDims=profile.orientation?(profile.orientation==='landscape'?[Math.max(profile.widthMm,profile.heightMm),Math.min(profile.widthMm,profile.heightMm)]:[Math.min(profile.widthMm,profile.heightMm),Math.max(profile.widthMm,profile.heightMm)]):[profile.widthMm,profile.heightMm]
   if(![...dims,...deviceDims].every(Number.isFinite)||dims.some((value,i)=>Math.abs(value-deviceDims[i])>.1))fail(409,'El papel y el perfil no coinciden. Usa PDF sin equipo; no se ajustará la escala')
   if(input.document==='GUIDE')fail(409,'La guía se prepara como PDF separado, sin destino de etiquetas')
 }
 return route
}
async function insert(tx,scope,input,snapshot,parent=null,reason=null,requestHash=hash(input)){
 const route=await routeFor(tx,scope,input,snapshot)
 if(input.document==='GUIDE'&&(input.source.kind!=='LABEL_PREPARATION'||!snapshot.prepared.paper.includeGuide))fail(400,'Este origen no tiene guía')
 return tx.hardwarePrintJob.create({data:{...operationScope(scope),actor_id:scope.actorId,request_key:input.requestKey,request_hash:requestHash,source_kind:input.source.kind,source_id:input.source.id,snapshot,route_snapshot:route||{},workstation_id:route?.workstationId||null,parent_id:parent,reason,document:input.document,pages:[],state:'CREATED'}})
}
async function createJob(db,scope,raw){
 const input=jobInput(raw);operationScope(scope)
 return atomic(db,async tx=>{
  await lock(tx,scope,input.requestKey)
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`hardware:${scope.companyId}:${scope.branchId}`},0))`
  const existing=await tx.hardwarePrintJob.findFirst({where:{company_id:scope.companyId,actor_id:scope.actorId,request_key:input.requestKey}})
  if(existing){if(existing.branch_id!==scope.branchId||existing.request_hash!==hash(input)||existing.parent_id)fail(409,'La petición ya corresponde a otro trabajo');await authorizeSource(tx,scope,source(existing));return dto(existing)}
  if(input.source.kind==='SALE_TICKET')await lockPrintBranding(tx)
  const snapshot=await resolvePrintSource(tx,scope,input.source)
  return dto(await insert(tx,scope,input,snapshot))
 })
}
const getJob=async(db,scope,id)=>dto(await ownJob(db,scope,id))
async function jobDocument(db,scope,id){const row=await ownJob(db,scope,id);return{...row.snapshot,branding:{jobId:row.id,companyId:scope.companyId,branchId:scope.branchId}}}
async function jobLogo(db,scope,id){const row=await ownJob(db,scope,id),url=row.snapshot.options?.logoUrl;if(!url)fail(404,'Este documento no tiene logo');const logo=await fetchLogoForHttp(url);if(!logo)fail(404,'El logo original no está disponible');return logo}
async function recordEvent(db,scope,id,raw){
 const input=eventInput(raw)
 return atomic(db,async tx=>{
  await lock(tx,scope,id);const row=await ownJob(tx,scope,id)
  const previous=await tx.hardwarePrintEvent.findFirst({where:{job_id:id,request_key:input.requestKey}})
  if(previous){if(previous.event!==input.event||previous.error_code!==input.errorCode)fail(409,'La referencia del evento ya fue utilizada');return dto(row)}
  const allowed={CREATED:['PREPARED','FAILED'],PREPARED:['DOWNLOAD_REQUESTED','FAILED'],DOWNLOAD_REQUESTED:['DOWNLOAD_REQUESTED','FAILED'],FAILED:[]}
  if(!allowed[row.state]?.includes(input.event))fail(409,'Este trabajo necesita una nueva copia para continuar')
  await tx.hardwarePrintEvent.create({data:{job_id:id,company_id:scope.companyId,branch_id:scope.branchId,actor_id:scope.actorId,request_key:input.requestKey,event:input.event,error_code:input.errorCode}})
  await tx.hardwarePrintJob.updateMany({where:{id,state:row.state},data:{state:input.event}})
  return dto({...row,state:input.event})
 })
}
async function reprintJob(db,scope,id,raw){
 const input=reprintInput(raw)
 return atomic(db,async tx=>{
  await lock(tx,scope,input.requestKey);const parent=await ownJob(tx,scope,id)
  const previous=await tx.hardwarePrintJob.findFirst({where:{company_id:scope.companyId,actor_id:scope.actorId,request_key:input.requestKey}})
  const requestHash=hash({parentId:id,...input})
  if(previous){if(previous.parent_id!==id||previous.request_hash!==requestHash||previous.branch_id!==scope.branchId)fail(409,'La petición ya fue utilizada');return dto(previous)}
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`hardware:${scope.companyId}:${scope.branchId}`},0))`
  return dto(await insert(tx,scope,{requestKey:input.requestKey,source:source(parent),document:parent.document,pages:parent.pages,workstationId:input.pdfOnly?null:parent.workstation_id,destinationId:input.pdfOnly?null:parent.route_snapshot?.destination?.id||null},parent.snapshot,id,input.reason,requestHash))
 })
}
async function printHistory(db,scope,raw={}){
 if(!has(scope,'hardware.view'))fail(403,'No tienes permiso para consultar el historial')
 if(!scope.companyId)fail(400,'Selecciona una empresa')
 const page=Number(raw.page||1),pageSize=Number(raw.pageSize||10)
 if(!Number.isSafeInteger(page)||page<1||![10,25,50,100].includes(pageSize))fail(400,'Paginación no válida')
 const where={company_id:scope.companyId,branch_id:scope.branchId||{in:scope.branchIds||[]}}
 const totalItems=await db.hardwarePrintJob.count({where}),totalPages=Math.max(1,Math.ceil(totalItems/pageSize)),current=Math.min(page,totalPages)
 const rows=await db.hardwarePrintJob.findMany({where,select:{id:true,actor_id:true,parent_id:true,source_kind:true,source_id:true,workstation_id:true,route_snapshot:true,state:true,document:true,pages:true,created_at:true,reason:true},orderBy:[{created_at:'desc'},{id:'desc'}],skip:(current-1)*pageSize,take:pageSize})
 const items=rows.map(row=>{
  let reprint=false
  if(row.actor_id===scope.actorId){
   try{originPermission(scope,row.source_kind==='SALE_TICKET'?'RECEIPT':'LABEL');reprint=true}
   catch(error){if(![400,403].includes(error.status))throw error}
  }
  return{...dto(row),capabilities:{reprint}}
 })
 return{items,page:current,pageSize,totalItems,totalPages}
}
module.exports={createJob,getJob,jobDocument,jobLogo,recordEvent,reprintJob,printHistory}
