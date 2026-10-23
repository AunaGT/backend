const {compileTemplate,resolveBase,freezeProfile}=require('./public')
const {hash,schemaManifest}=require('./contract')
const {authorize,fail}=require('./permissions')
const {readAppearance}=require('./appearance')
const UUID=/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i
function id(value){if(!UUID.test(value||''))throw fail(400,'Identificador no válido');return value}
function requestKey(value){if(typeof value!=='string'||!/^[\w:-]{1,120}$/.test(value))throw fail(400,'Falta una clave de operación válida');return value}
async function lock(tx,key){await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key},0))`}
async function command(db,scope,action,input,run) {
  const key=requestKey(input.requestKey),inputHash=hash(input)
  return db.$transaction(async tx=>{
    await lock(tx,`document-command:${scope.companyId}:${scope.actorId}:${action}:${key}`)
    const old=await tx.documentEvent.findFirst({where:{company_id:scope.companyId,actor_id:scope.actorId,action,request_key:key}})
    if(old){if(old.input_hash!==inputHash)throw fail(409,'Esta operación ya se usó con otros datos');return old.result}
    const result=await run(tx)
    await tx.documentEvent.create({data:{company_id:scope.companyId,actor_id:scope.actorId,action,request_key:key,input_hash:inputHash,entity_id:result.id||null,result}})
    return result
  },{maxWait:10000,timeout:15000})
}
function dto(row,version=row.versions?.[0]){
  return {id:row.id,name:row.name,purpose:row.purpose,format:row.format,version:row.revision,state:row.state,status:row.state==='ARCHIVED'?'ARCHIVED':version?.state||'DRAFT',versionId:version?.id,versionNumber:version?.number,design:version?.design,source:version?.source,updatedAt:row.updated_at?.toISOString?.()||row.updated_at}
}
async function find(tx,scope,templateId) {
  const row=await tx.documentTemplate.findFirst({where:{company_id:scope.companyId,id:id(templateId)},include:{versions:{orderBy:{number:'desc'},take:1}}})
  if(!row)throw fail(404,'Plantilla no encontrada');return row
}
async function getTemplate(db,scope,templateId){authorize(scope);return dto(await find(db,scope,templateId))}
async function listTemplates(db,scope,{page=1,pageSize=25,format,status}={}) {
  const tenant=authorize(scope)
  page=Number(page);pageSize=Number(pageSize)
  if(!Number.isSafeInteger(page)||page<1||![10,25,50,100].includes(pageSize))throw fail(400,'Paginación no válida')
  if(format&&!schemaManifest.formats.includes(format)||status&&!['ACTIVE','ARCHIVED'].includes(status))throw fail(400,'Filtro no válido')
  const where={...tenant,...(format?{format}:{}),state:status||'ACTIVE'}
  const [rows,total]=await Promise.all([db.documentTemplate.findMany({where,include:{versions:{orderBy:{number:'desc'},take:1}},orderBy:[{updated_at:'desc'},{id:'asc'}],skip:(page-1)*pageSize,take:pageSize}),db.documentTemplate.count({where})])
  const defaults=await db.documentTemplateDefault.findMany({where:{company_id:scope.companyId},include:{version:true}})
  return {rows:rows.map(row=>{const active=defaults.find(d=>d.version?.template_id===row.id)?.version;return {...dto(row),isDefault:!!active,...(active?{activeVersionNumber:active.number}:{})}}),total,page,pageSize,bases:schemaManifest.bases}
}
function nameOf(name){if(typeof name!=='string'||!name.trim()||name.trim().length>150)throw fail(400,'Escribe un nombre de hasta 150 caracteres');return name.trim()}
async function writeDraft(tx,scope,input) {
  const compiled=compileTemplate({design:input.design}),{design,source}=compiled
  const name=nameOf(input.name)
  if(!Number.isSafeInteger(input.expectedVersion)||input.expectedVersion<0)throw fail(428,'Recarga la plantilla antes de guardar')
  let row
  if(input.id) {
    row=await find(tx,scope,input.id)
    if(row.state==='ARCHIVED')throw fail(409,'Duplica una plantilla archivada para editarla')
    if(row.purpose!==design.purpose||row.format!==design.paper.format)throw fail(409,'Crea otra plantilla para cambiar el tipo o formato')
    const claimed=await tx.documentTemplate.updateMany({where:{company_id:scope.companyId,id:row.id,revision:input.expectedVersion},data:{name,revision:{increment:1}}})
    if(claimed.count!==1)throw fail(409,'Otra persona cambió esta plantilla. Tus cambios no se han descartado')
    row={...row,name,revision:row.revision+1}
  } else {
    if(input.expectedVersion!==0)throw fail(409,'La versión inicial debe ser cero')
    row=await tx.documentTemplate.create({data:{company_id:scope.companyId,name,purpose:design.purpose,format:design.paper.format,base_id:design.base.id,created_by:scope.actorId}})
  }
  const previous=row.versions?.[0],values={design,source,design_hash:hash(design)}
  let version
  if(previous?.state==='DRAFT') {
    await tx.documentTemplateVersion.updateMany({where:{company_id:scope.companyId,id:previous.id,state:'DRAFT'},data:values})
    version={...previous,...values}
  }else version=await tx.documentTemplateVersion.create({data:{company_id:scope.companyId,template_id:row.id,number:(previous?.number||0)+1,created_by:scope.actorId,resource_refs:previous?.resource_refs||input.resourceRefs||{},...values}})
  return dto(row,version)
}
async function saveDraft(db,scope,input){
  authorize(scope,'manage')
  if(Object.keys(input).some(k=>!['id','expectedVersion','design','name','requestKey'].includes(k)))throw fail(400,'Opción no admitida')
  return command(db,scope,'SAVE_DRAFT',input,tx=>writeDraft(tx,scope,input))
}
async function duplicateTemplate(db,scope,input) {
  authorize(scope,'manage')
  if(Boolean(input.baseId)===Boolean(input.templateId))throw fail(400,'Selecciona una base o una plantilla, no ambas')
  return command(db,scope,'DUPLICATE',input,async tx=>{
    const original=input.templateId?(await find(tx,scope,input.templateId)).versions[0]:null
    const design=input.baseId?resolveBase(input.baseId,input.format||'LETTER',input.purpose||'INTERNAL_RECEIPT'):original.design
    return writeDraft(tx,scope,{name:input.name,design,expectedVersion:0,resourceRefs:original?.resource_refs||{}})
  })
}
async function resetDraft(db,scope,input){authorize(scope,'manage');return command(db,scope,'RESET',input,async tx=>{
  const old=await find(tx,scope,input.id)
  return writeDraft(tx,scope,{...input,name:old.name,design:resolveBase(input.baseId||old.base_id,old.format,old.purpose)})
})}
async function resolveProfiles(tx,scope,purpose) {
  await lock(tx,`document-appearance:${scope.companyId}`)
  const appearance=await readAppearance(tx,scope,false)
  const defaults=await tx.documentTemplateDefault.findMany({where:{company_id:scope.companyId,purpose},include:{version:true}})
  const profiles={}
  for(const format of schemaManifest.formats){
    const version=defaults.find(d=>d.format===format)?.version
    if(version&&version.state!=='PUBLISHED')throw fail(409,'La plantilla predeterminada no está publicada')
    const design=version?.design||resolveBase('CLASSIC',format,purpose)
    profiles[format]=freezeProfile(design,appearance.values,[...await resourceRefs(tx,scope,version),...await logoRefs(tx,scope,design)],version?.id||null)
  }
  return profiles
}
async function resourceRefs(tx,scope,version) {
  const slots=[...new Set((version?.design.blocks||[]).flatMap(b=>b.settings.images||[]))]
  if(!slots.length)return []
  const mapped=slots.map(slot=>version.resource_refs?.[slot])
  if(mapped.some(x=>!UUID.test(x||'')))throw fail(409,'Asocia las imágenes que usa este diseño')
  const rows=await tx.documentTemplateAsset.findMany({where:{company_id:scope.companyId,id:{in:mapped}}})
  if(rows.length!==new Set(mapped).size)throw fail(404,'Imagen no disponible en esta empresa')
  return slots.map((slot,i)=>{const row=rows.find(r=>r.id===mapped[i]);return {id:slot,role:'image',assetId:row.id,path:row.path,sha256:row.sha256,required:true}})
}
async function logoRefs(tx,scope,design) {
  if(!design.blocks.find(b=>b.kind==='HEADER')?.settings.showLogo)return []
  const row=await tx.systemSetting.findFirst({where:{company_id:scope.companyId,key:'company_logo_url'}})
  return row?.value?[{id:'company-logo',role:'logo',sourceUrl:row.value,required:true}]:[]
}
async function publishTemplate(db,scope,input) {
  authorize(scope,'publish')
  return command(db,scope,'PUBLISH',input,async tx=>{
    const row=await find(tx,scope,input.id),version=row.versions[0]
    if(row.revision!==input.expectedVersion||row.state!=='ACTIVE'||!['DRAFT','PUBLISHED'].includes(version?.state))throw fail(409,'Recarga el borrador antes de publicarlo')
    if(row.purpose!=='INTERNAL_RECEIPT')throw fail(409,'La publicación fiscal se habilitará con el certificador','FISCAL_CONNECTOR_UNAVAILABLE')
    const ids=input.validationArtifactIds
    if(!Array.isArray(ids)||ids.length!==3||new Set(ids).size!==3)throw fail(409,'Genera las tres vistas previas de validación antes de publicar')
    ids.forEach(id)
    await lock(tx,`document-appearance:${scope.companyId}`)
    const appearance=await readAppearance(tx,scope,false)
    const profile=freezeProfile(version.design,appearance.values,[...await resourceRefs(tx,scope,version),...await logoRefs(tx,scope,version.design)])
    const artifacts=await tx.documentArtifact.findMany({where:{company_id:scope.companyId,id:{in:ids},state:'READY',profile_hash:profile.designHash,renderer_version:profile.rendererVersion},include:{snapshot:true}})
    const scenarios=new Set()
    for(const artifact of artifacts){
      const s=artifact.snapshot
      if(!s||s.company_id!==scope.companyId||s.actor_id!==scope.actorId||s.source_kind!=='PREVIEW'||new Date(s.expires_at)<=new Date())throw fail(404,'Vista previa no disponible')
      scenarios.add(s.scenario)
    }
    if(artifacts.length!==3||!['SHORT','LONG','LONG_TEXT'].every(x=>scenarios.has(x)))throw fail(409,'Las validaciones no corresponden al diseño y apariencia actuales')
    await lock(tx,`document-default:${scope.companyId}:${row.purpose}:${row.format}`)
    const claim=await tx.documentTemplate.updateMany({where:{company_id:scope.companyId,id:row.id,revision:input.expectedVersion,state:'ACTIVE'},data:{revision:{increment:1}}})
    if(claim.count!==1)throw fail(409,'Otra persona cambió esta plantilla')
    if(version.state==='DRAFT'){
      const published=await tx.documentTemplateVersion.updateMany({where:{company_id:scope.companyId,id:version.id,state:'DRAFT'},data:{state:'PUBLISHED',published_at:new Date()}})
      if(published.count!==1)throw fail(409,'Esta versión ya fue publicada')
    }
    if(input.setDefault)await tx.documentTemplateDefault.upsert({where:{company_id_purpose_format:{company_id:scope.companyId,purpose:row.purpose,format:row.format}},create:{company_id:scope.companyId,purpose:row.purpose,format:row.format,version_id:version.id},update:{version_id:version.id}})
    return dto({...row,revision:row.revision+1},{...version,state:'PUBLISHED'})
  })
}
async function archiveTemplate(db,scope,input) {
  authorize(scope,'publish')
  return command(db,scope,'ARCHIVE',input,async tx=>{
    const row=await find(tx,scope,input.id)
    await lock(tx,`document-default:${scope.companyId}:${row.purpose}:${row.format}`)
    const current=await tx.documentTemplateDefault.findFirst({where:{company_id:scope.companyId,purpose:row.purpose,format:row.format},include:{version:true}})
    if(current?.version?.template_id===row.id) {
      const replacement=input.replacementVersionId&&await tx.documentTemplateVersion.findFirst({where:{company_id:scope.companyId,id:id(input.replacementVersionId),state:'PUBLISHED'},include:{template:true}})
      if(!replacement||replacement.template_id===row.id||replacement.template?.state!=='ACTIVE'||replacement.template?.format!==row.format||replacement.template?.purpose!==row.purpose)throw fail(409,'Selecciona otra versión publicada como predeterminada antes de archivar')
      await tx.documentTemplateDefault.updateMany({where:{company_id:scope.companyId,purpose:row.purpose,format:row.format},data:{version_id:replacement.id}})
    }
    const result=await tx.documentTemplate.updateMany({where:{company_id:scope.companyId,id:row.id,revision:input.expectedVersion,state:'ACTIVE'},data:{state:'ARCHIVED',revision:{increment:1}}})
    if(result.count!==1)throw fail(409,'Recarga la plantilla antes de archivar')
    return dto({...row,state:'ARCHIVED',revision:row.revision+1})
  })
}
async function versions(db,scope,templateId){authorize(scope);await find(db,scope,templateId);return db.documentTemplateVersion.findMany({where:{company_id:scope.companyId,template_id:templateId},select:{id:true,number:true,state:true,published_at:true,created_at:true,design_hash:true},orderBy:{number:'desc'},take:100})}
async function discardDraft(db,scope,input){
  authorize(scope,'manage')
  return command(db,scope,'DISCARD',input,async tx=>{
    const row=await find(tx,scope,input.id)
    if(await tx.documentTemplateVersion.count({where:{company_id:scope.companyId,template_id:row.id,state:'PUBLISHED'}}))throw fail(409,'Esta plantilla conserva versiones publicadas; usa Archivar con permiso de publicación')
    const claim=await tx.documentTemplate.updateMany({where:{company_id:scope.companyId,id:row.id,revision:input.expectedVersion,state:'ACTIVE'},data:{state:'ARCHIVED',revision:{increment:1}}})
    if(claim.count!==1)throw fail(409,'Recarga el borrador antes de descartarlo')
    return dto({...row,state:'ARCHIVED',revision:row.revision+1})
  })
}
module.exports={id,requestKey,lock,command,getTemplate,listTemplates,saveDraft,duplicateTemplate,resetDraft,publishTemplate,archiveTemplate,discardDraft,resolveProfiles,resourceRefs,logoRefs,versions}
