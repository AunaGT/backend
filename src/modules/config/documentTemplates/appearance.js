const {validateAppearance,check,hash}=require('./contract')
const {authorize,fail}=require('./permissions')
const {setSettingsActor,writeSettings}=require('../../../services/settingsRevision')
const KEY='invoices.appearance'
async function readAppearance(db,scope,permission=true) {
  if(permission)authorize(scope)
  const row=await db.systemSetting.findFirst({where:{company_id:scope.companyId,key:KEY}})
  return {values:row?JSON.parse(row.value):{},revision:row?.revision||0}
}
async function saveAppearance(db,scope,input) {
  authorize(scope,'manage');validateAppearance(input.values)
  check(Object.keys(input).every(k=>['values','expectedRevision','requestKey'].includes(k)),'input','Opción no admitida')
  if(!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<0)throw fail(428,'Recarga la apariencia antes de guardar')
  const {command,lock}=require('./service')
  return command(db,scope,'APPEARANCE',input,async tx=>{
    await lock(tx,`document-appearance:${scope.companyId}`)
    await setSettingsActor(tx,{actorId:scope.actorId,source:'document_templates.appearance'})
    const rows=await writeSettings(tx,{companyId:scope.companyId,changes:{[KEY]:{value:JSON.stringify(input.values),type:'json',description:'Apariencia de documentos internos'}},expectedRevisions:{[KEY]:input.expectedRevision}})
    const row=rows.find(r=>r.key===KEY)
    return {values:JSON.parse(row.value),revision:row.revision,hash:hash(input.values)}
  })
}
module.exports={KEY,readAppearance,saveAppearance}
