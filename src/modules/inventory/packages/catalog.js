const {randomUUID,createHash}=require('node:crypto')
const {resolveEffectiveModules}=require('../../platform/registry')
const {parsePackageDefinition,object,uuid,integer,text,array,invalid}=require('./definition')
const {validateReferences}=require('./references')
function fail(status,code,message){throw Object.assign(new Error(message),{status,code})}
const branchIds=scope=>[...new Set(scope.branchIds??(scope.branchId?[scope.branchId]:[]))]
function authorize(scope,{write=false}={}) {
  if(!scope?.companyId)fail(403,'FORBIDDEN','Selecciona una empresa')
  uuid(scope.companyId,'companyId')
  if(!scope.isAdmin&&!scope.permissions?.includes(write?'products.edit':'products.view'))fail(403,'FORBIDDEN','No tienes permiso para gestionar paquetes')
  if(write&&!scope.branchId)fail(400,'BRANCH_REQUIRED','Selecciona una sucursal; la vista consolidada es solo de consulta')
  if(write&&!scope.actorId)fail(403,'FORBIDDEN','Inicia sesión para guardar cambios')
  if(write)uuid(scope.actorId,'actorId')
  if(scope.branchId)uuid(scope.branchId,'branchId')
  branchIds(scope).forEach(id=>uuid(id,'branchIds'))
}
async function enabled(db,scope) {
  const modules=resolveEffectiveModules(await db.companyModule.findMany({where:{company_id:scope.companyId}}))
  if(!modules.find(module=>module.code==='inventory')?.effectiveEnabled)fail(403,'MODULE_DISABLED','Inventario no está habilitado para esta empresa')
  if(!db.commercialPackage)fail(503,'PACKAGES_NOT_READY','La actualización de paquetes aún no está instalada')
}
async function assertPackageWriteAccess(db,scope){
  authorize(scope,{write:true});await enabled(db,scope)
  if(!branchIds(scope).includes(scope.branchId))fail(403,'FORBIDDEN','Sucursal no autorizada')
  const branch=await db.branch.findFirst({where:{id:scope.branchId,company_id:scope.companyId,active:true},select:{id:true}})
  if(!branch)fail(403,'FORBIDDEN','Sucursal no autorizada')
}
function visible(scope) {
  return{company_id:scope.companyId,branches:{some:{branch_id:{in:scope.branchId?[scope.branchId]:branchIds(scope)}}}}
}
async function load(db,scope,id,{lock=false}={}) {
  uuid(id,'packageId')
  if(lock)await db.$executeRaw`SELECT id FROM commercial_packages WHERE company_id=${scope.companyId}::uuid AND id=${id}::uuid FOR UPDATE`
  const row=await db.commercialPackage.findFirst({where:{id,...visible(scope)},include:{branches:true}})
  if(!row)fail(404,'NOT_FOUND','Paquete no encontrado')
  return row
}
function assertSharedAccess(scope,row) {
  if(row.branches.some(branch=>!branchIds(scope).includes(branch.branch_id)))fail(403,'FORBIDDEN','El paquete es compartido; necesitas acceso a todas sus sucursales')
}
const receipt=row=>({id:row.id,version:row.version,activeVersion:row.active_version??null,archivedAt:row.archived_at?.toISOString()??null})
const summary=row=>({...receipt(row),name:row.name,branchIds:row.branches.map(branch=>branch.branch_id)})
async function listPackages(db,scope,query={}) {
  authorize(scope);await enabled(db,scope)
  object(query,['limit','cursor','q','branchId','includeArchived','activeOnly'],'query')
  const limit=integer(query.limit===undefined?25:Number(query.limit),'limit',1,100)
  const where={...visible(scope)}
  if(query.branchId!==undefined){uuid(query.branchId,'branchId');if(!branchIds(scope).includes(query.branchId))fail(403,'FORBIDDEN','Sucursal no autorizada');where.branches={some:{branch_id:query.branchId}}}
  const flag=(value,path)=>{if(![undefined,true,false,'true','false'].includes(value))invalid(path,'Selecciona sí o no');return value===true||value==='true'}
  if(!flag(query.includeArchived,'includeArchived'))where.archived_at=null
  if(flag(query.activeOnly,'activeOnly'))where.active_version={not:null}
  if(query.cursor!==undefined)where.id={gt:uuid(query.cursor,'cursor')}
  if(query.q!==undefined)where.name={contains:text(query.q,'q',100,false),mode:'insensitive'}
  const rows=await db.commercialPackage.findMany({where,include:{branches:true},orderBy:{id:'asc'},take:limit+1}),items=rows.slice(0,limit)
  return{items:items.map(summary),nextCursor:rows.length>limit?items.at(-1).id:null}
}
async function getPackage(db,scope,id) {
  authorize(scope);await enabled(db,scope)
  const row=await load(db,scope,id)
  const active=row.active_version?await db.commercialPackageVersion.findFirst({where:{company_id:scope.companyId,package_id:id,version:row.active_version}}):null
  return{...summary(row),definition:row.draft_definition,activeDefinition:active?.definition??null}
}
async function assignedBranches(tx,scope,ids) {
  if(ids.some(id=>!branchIds(scope).includes(id)))fail(403,'FORBIDDEN','Selecciona sucursales a las que tengas acceso')
  const rows=await tx.branch.findMany({where:{id:{in:ids},company_id:scope.companyId,active:true},select:{id:true}})
  if(rows.length!==ids.length)fail(404,'NOT_FOUND','Una sucursal del paquete no está disponible')
}
function key(value) {
  if(typeof value!=='string'||!/^[A-Za-z0-9._:-]{16,100}$/.test(value))invalid('idempotencyKey','Identificador de intento inválido')
  return value
}
function parseSave(raw) {
  object(raw,['expectedVersion','definition','branchIds','idempotencyKey'],'form')
  const ids=array(raw.branchIds,'branchIds',100).map(id=>uuid(id,'branchIds')).sort()
  if(!ids.length||new Set(ids).size!==ids.length)invalid('branchIds','Selecciona al menos una sucursal, sin repetirla')
  return{expectedVersion:integer(raw.expectedVersion,'expectedVersion',0,2147483647),definition:parsePackageDefinition(raw.definition,{complete:false}),
    branchIds:ids,idempotencyKey:key(raw.idempotencyKey)}
}
function parseAction(raw) {
  object(raw,['expectedVersion','idempotencyKey'],'form')
  return{expectedVersion:integer(raw.expectedVersion,'expectedVersion',1,2147483647),idempotencyKey:key(raw.idempotencyKey)}
}
async function command(db,scope,id,action,input,execute) {
  authorize(scope,{write:true});if(id!==null)uuid(id,'packageId')
  const inputHash=createHash('sha256').update(JSON.stringify({id,action,input})).digest('hex')
  return db.$transaction(async tx=>{
    await enabled(tx,scope)
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`package-command:${scope.companyId}:${scope.actorId}:${action}:${input.idempotencyKey}`},0))`
    const row=id?await load(tx,scope,id,{lock:true}):null
    if(row)assertSharedAccess(scope,row)
    if(input.branchIds)await assignedBranches(tx,scope,input.branchIds)
    const previous=await tx.commercialPackageCommand.findFirst({where:{company_id:scope.companyId,actor_id:scope.actorId,action,request_key:input.idempotencyKey}})
    if(previous){
      if(previous.input_hash!==inputHash)fail(409,'IDEMPOTENCY_CONFLICT','Este intento corresponde a otros datos')
      assertSharedAccess(scope,await load(tx,scope,previous.package_id))
      return previous.receipt
    }
    if(row&&row.version!==input.expectedVersion||!row&&input.expectedVersion!==0)fail(409,'PACKAGE_CHANGED','El paquete cambió; vuelve a cargarlo antes de guardar')
    if(row?.archived_at)fail(409,'PACKAGE_UNAVAILABLE','El paquete está archivado y conserva sus acuerdos anteriores')
    const result=await execute(tx,row)
    await tx.commercialPackageCommand.create({data:{id:randomUUID(),company_id:scope.companyId,actor_id:scope.actorId,action,
      package_id:result.id,request_key:input.idempotencyKey,input_hash:inputHash,receipt:result}})
    return result
  },{maxWait:15000,timeout:30000})
}
async function savePackage(db,scope,id,raw) {
  const input=parseSave(raw)
  return command(db,scope,id,'SAVE',input,async(tx,row)=>{
    const currency=await tx.systemSetting.findUnique({where:{company_id_key:{company_id:scope.companyId,key:'currency_code'}}})
    if(input.definition.currency!==(currency?.value||'GTQ'))fail(400,'CURRENCY_MISMATCH','Usa la moneda configurada para esta empresa')
    await validateReferences(tx,scope,input.definition,{lock:true})
    const data={name:input.definition.name,draft_definition:input.definition,updated_at:new Date()}
    let saved
    if(row){
      const changed=await tx.commercialPackage.updateMany({where:{id:row.id,company_id:scope.companyId,version:row.version},data:{...data,version:{increment:1}}})
      if(changed.count!==1)fail(409,'PACKAGE_CHANGED','El paquete cambió; vuelve a cargarlo')
      saved={...row,...data,version:row.version+1}
      await tx.commercialPackageBranch.deleteMany({where:{company_id:scope.companyId,package_id:row.id}})
    }else saved=await tx.commercialPackage.create({data:{id:randomUUID(),company_id:scope.companyId,created_by:scope.actorId,version:1,active_version:null,archived_at:null,...data}})
    await tx.commercialPackageBranch.createMany({data:input.branchIds.map(branch_id=>({company_id:scope.companyId,package_id:saved.id,branch_id}))})
    return receipt(saved)
  })
}
async function activatePackageVersion(db,scope,id,raw) {
  const input=parseAction(raw)
  return command(db,scope,id,'ACTIVATE',input,async(tx,row)=>{
    const definition=parsePackageDefinition(row.draft_definition,{complete:true}),ids=row.branches.map(branch=>branch.branch_id).sort()
    await assignedBranches(tx,scope,ids)
    const currency=await tx.systemSetting.findUnique({where:{company_id_key:{company_id:scope.companyId,key:'currency_code'}}})
    if(definition.currency!==(currency?.value||'GTQ'))fail(409,'CURRENCY_MISMATCH','La moneda cambió; revisa el paquete')
    await validateReferences(tx,scope,definition,{lock:true})
    const version=(row.active_version??0)+1,hash=createHash('sha256').update(JSON.stringify({definition,branchIds:ids})).digest('hex')
    await tx.commercialPackageVersion.create({data:{id:randomUUID(),company_id:scope.companyId,package_id:id,version,
      definition,branch_ids:ids,content_hash:hash,request_key:input.idempotencyKey,created_by:scope.actorId}})
    const changed=await tx.commercialPackage.updateMany({where:{id,company_id:scope.companyId,version:row.version},data:{active_version:version,version:{increment:1},updated_at:new Date()}})
    if(changed.count!==1)fail(409,'PACKAGE_CHANGED','El paquete cambió; vuelve a cargarlo')
    return receipt({...row,version:row.version+1,active_version:version})
  })
}
async function archivePackage(db,scope,id,raw) {
  const input=parseAction(raw)
  return command(db,scope,id,'ARCHIVE',input,async(tx,row)=>{
    const archived_at=new Date()
    const changed=await tx.commercialPackage.updateMany({where:{id,company_id:scope.companyId,version:row.version},data:{archived_at,version:{increment:1},updated_at:archived_at}})
    if(changed.count!==1)fail(409,'PACKAGE_CHANGED','El paquete cambió; vuelve a cargarlo')
    return receipt({...row,version:row.version+1,archived_at})
  })
}
async function loadPackageVersion(tx,scope,id,version,{forNewSelection=true}={}) {
  authorize(scope);await enabled(tx,scope);uuid(id,'packageId');integer(version,'version',1,2147483647)
  const row=await tx.commercialPackage.findFirst({where:{id,company_id:scope.companyId},include:{branches:true}})
  const record=await tx.commercialPackageVersion.findFirst({where:{company_id:scope.companyId,package_id:id,version}})
  if(!row||!record||!scope.branchId||!record.branch_ids.includes(scope.branchId)||!branchIds(scope).includes(scope.branchId))fail(404,'NOT_FOUND','Versión del paquete no encontrada')
  if(forNewSelection&&(row.archived_at||row.active_version!==version||!row.branches.some(branch=>branch.branch_id===scope.branchId)))fail(409,'PACKAGE_UNAVAILABLE','La versión del paquete ya no está disponible para selecciones nuevas')
  const definition=parsePackageDefinition(record.definition,{complete:true})
  const products=forNewSelection?await validateReferences(tx,scope,definition,{lock:true}):null
  return{packageId:id,version,definition,branchIds:record.branch_ids,products}
}
module.exports={listPackages,getPackage,savePackage,activatePackageVersion,archivePackage,loadPackageVersion,assertPackageWriteAccess}
