const fail=(status,message)=>Object.assign(new Error(message),{status})
const conflict=()=>fail(409,'Otra persona cambió esta configuración. Revisa los valores actuales antes de volver a guardar.')
function settingRevisions(rows,keys=rows.map(row=>row.key)) {
  const byKey=new Map(rows.map(row=>[row.key,row.revision]))
  return Object.fromEntries(keys.map(key=>[key,byKey.get(key) ?? 0]))
}
function assertExpectedRevisions(changes,expected) {
  if(expected===undefined)throw fail(428,'Recarga la configuración antes de guardar: faltan sus revisiones.')
  if(!expected||typeof expected!=='object'||Array.isArray(expected))throw fail(400,'Las revisiones de configuración no son válidas.')
  for(const key of Object.keys(changes)) if(!Object.hasOwn(expected,key)||!Number.isSafeInteger(expected[key])||expected[key]<0)throw fail(400,`La revisión de ${key} no es válida.`)
}
async function setSettingsActor(tx,{actorId,source}) {
  await tx.$queryRaw`SELECT set_config('auna.settings_actor', ${actorId || ''}, true), set_config('auna.settings_source', ${source || 'system'}, true)`
}
async function readSettingsRevisions(db,companyId,keys) {
  return settingRevisions(await db.systemSetting.findMany({where:{company_id:companyId,key:{in:keys}},select:{key:true,revision:true}}),keys)
}
// The caller owns the transaction: a conflict in any key must roll back them all.
async function writeSettings(tx,{companyId,changes,expectedRevisions}) {
  assertExpectedRevisions(changes,expectedRevisions)
  if(Object.hasOwn(changes,'inventory_units_enabled'))await require('../modules/inventory/units').assertUnitsSettingChange(tx,companyId,changes.inventory_units_enabled.value)
  for(const key of Object.keys(changes).sort()) {
    const data=changes[key],revision=expectedRevisions[key]
    if(revision===0) {
      try{await tx.systemSetting.create({data:{company_id:companyId,key,...data}})}catch(error){if(error.code==='P2002')throw conflict();throw error}
    }else {
      const claim=await tx.systemSetting.updateMany({where:{company_id:companyId,key,revision},data})
      if(claim.count!==1)throw conflict()
    }
  }
  return tx.systemSetting.findMany({where:{company_id:companyId,key:{in:Object.keys(changes)}},orderBy:{key:'asc'}})
}
module.exports={settingRevisions,assertExpectedRevisions,setSettingsActor,readSettingsRevisions,writeSettings}
