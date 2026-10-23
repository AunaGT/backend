const {authorize,fail}=require('./permissions')
const {command,id,lock,resourceRefs,logoRefs}=require('./service')
const {compileTemplate,freezeProfile}=require('./public')
const {readAppearance}=require('./appearance')
const {lockPrintBranding}=require('../hardware/printing/branding')
const {artifactDto}=require('../../sales/documents/artifacts')
function scenarioData(scenario,purpose='INTERNAL_RECEIPT') {
  if(!['SHORT','LONG','LONG_TEXT'].includes(scenario))throw fail(400,'Selecciona una prueba corta, larga o de texto extenso')
  return {schemaVersion:1,purpose,issuedAt:'2026-10-22T12:00:00.000Z',saleReference:'MUESTRA-0001',
    emitter:{name:'Empresa de muestra',nit:'CF',address:'Dirección ficticia para comprobar el diseño',branch:'Sucursal de muestra'},receiver:{name:'Cliente de muestra',nit:'CF'},
    lines:Array.from({length:scenario==='SHORT'?1:scenario==='LONG'?200:20},(_,i)=>({name:scenario==='LONG_TEXT'?`Artículo ${i+1} · Café de especialidad en presentación familiar, descripción extensa para comprobar saltos de línea, acentos y espacio disponible sin recortar información.`:`Artículo ${i+1} · Café de muestra`,quantity:'0.123456',unit:'kg',price:'18.90',total:'2.33'})),
    totals:{subtotal:'100.00',discount:'10.00',total:'90.00',currency:'Q'},paymentAtPreparation:{method:'Método de muestra'},
    notices:['MUESTRA · SIN VALIDEZ FISCAL'],fiscal:purpose==='FEL_INVOICE'?{fixture:true,verificationText:'https://example.invalid/fel-demo'}:null}
}
function canPreview(scope){authorize(scope);if(!scope.isAdmin&&!['document_templates.manage','document_templates.publish'].some(p=>scope.permissions?.includes(p)))throw fail(403,'No tienes permiso para preparar vistas previas')}
async function requestPreview(db,scope,input) {
  canPreview(scope)
  return command(db,scope,'PREVIEW',input,async tx=>{
    let version
    if(Boolean(input.templateId)===Boolean(input.design))throw fail(400,'Selecciona una plantilla o un diseño')
    if(input.templateId){
      const row=await tx.documentTemplate.findFirst({where:{company_id:scope.companyId,id:id(input.templateId),state:'ACTIVE'},include:{versions:{orderBy:{number:'desc'},take:1}}})
      if(!row)throw fail(404,'Plantilla no encontrada')
      if(input.expectedVersion!==row.revision)throw fail(409,'Guarda o recarga el diseño antes de generar su vista previa')
      version=row.versions[0]
    }
    const design=compileTemplate({design:version?.design||input.design}).design
    await lockPrintBranding(tx);await lock(tx,`document-appearance:${scope.companyId}`)
    const appearance=await readAppearance(tx,scope,false),refs=[...await resourceRefs(tx,scope,version),...await logoRefs(tx,scope,design)]
    const profile=freezeProfile(design,appearance.values,refs),logoRef=refs.find(r=>r.role==='logo')?.sourceUrl||''
    let data,scenario=input.scenario
    if(input.saleId){
      if(design.purpose!=='INTERNAL_RECEIPT')throw fail(409,'Las pruebas fiscales solo admiten datos ficticios','FISCAL_CONNECTOR_UNAVAILABLE')
      const {authorizeSaleDocument}=require('../../sales/documents/snapshot'),{documentData}=require('../../sales/documents/data')
      const sale=await authorizeSaleDocument(tx,scope,id(input.saleId),{includeData:true});data=documentData(sale);scenario='REAL_SALE'
    }else data=scenarioData(scenario,design.purpose)
    const snapshot=await tx.documentSnapshot.create({data:{company_id:scope.companyId,branch_id:input.saleId?scope.branchId:null,purpose:design.purpose,source_kind:'PREVIEW',actor_id:scope.actorId,scenario,expires_at:new Date(Date.now()+86400000),data,profiles:{[profile.format]:profile},branding:{logoRef,...(input.saleId?{previewSaleId:input.saleId}:{})}}})
    const artifact=await tx.documentArtifact.create({data:{company_id:scope.companyId,snapshot_id:snapshot.id,format:profile.format,profile_hash:profile.designHash,renderer_version:profile.rendererVersion,profile,state:'QUEUED'}})
    return artifactDto(artifact)
  })
}
async function previewRow(db,scope,artifactId) {
  authorize(scope);id(artifactId)
  const row=await db.documentArtifact.findFirst({where:{company_id:scope.companyId,id:artifactId,snapshot:{source_kind:'PREVIEW',company_id:scope.companyId,actor_id:scope.actorId,expires_at:{gt:new Date()}}},include:{snapshot:true}})
  if(!row)throw fail(404,'La vista previa venció o no está disponible')
  if(row.snapshot.scenario==='REAL_SALE'){
    if(!row.snapshot.branding?.previewSaleId||row.snapshot.branch_id!==scope.branchId)throw fail(404,'Vista previa no disponible')
    await require('../../sales/documents/snapshot').authorizeSaleDocument(db,scope,row.snapshot.branding.previewSaleId)
  }
  return row
}
async function getPreview(db,scope,artifactId){return artifactDto(await previewRow(db,scope,artifactId))}
async function downloadPreview(db,scope,artifactId) {
  const row=await previewRow(db,scope,artifactId)
  if(row.state!=='READY')throw fail(409,'La vista previa aún no está lista','DOCUMENT_NOT_READY')
  return {buffer:await require('../../sales/documents/storage').downloadPdf(row),filename:'muestra-sin-validez-fiscal.pdf'}
}
module.exports={scenarioData,requestPreview,getPreview,downloadPreview}
