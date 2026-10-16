const EXPIRY_ALERT_POLICY_KEY='inventory.expiry_alert_policy'
const DEFAULT_EXPIRY_ALERT_POLICY=Object.freeze({warningDays:30,highPriorityDays:7})
const invalid=()=>Object.assign(Error('Configura días enteros: aviso entre 1 y 3650, prioridad entre 0 y los días de aviso.'),{status:400})
const integer=value=>['number','string'].includes(typeof value)&&String(value).trim()!==''&&Number.isSafeInteger(Number(value))
function validateExpiryAlertPolicy(raw){
  if(!raw||typeof raw!=='object'||Array.isArray(raw)||!integer(raw.warningDays)||!integer(raw.highPriorityDays))throw invalid()
  const warningDays=Number(raw.warningDays),highPriorityDays=Number(raw.highPriorityDays)
  if(warningDays<1||warningDays>3650||highPriorityDays<0||highPriorityDays>warningDays)throw invalid()
  return{warningDays,highPriorityDays}
}
function expiryPolicyFromStored(value){
  try{return validateExpiryAlertPolicy(typeof value==='string'?JSON.parse(value):value)}
  catch{throw Object.assign(Error('La política de vencimientos guardada no es válida. Revisa su configuración antes de sincronizar alertas.'),{status:409})}
}
async function getExpiryAlertPolicy(db,companyId){
  const row=await db.systemSetting.findUnique({where:{company_id_key:{company_id:companyId,key:EXPIRY_ALERT_POLICY_KEY}}})
  return row?expiryPolicyFromStored(row.value):{...DEFAULT_EXPIRY_ALERT_POLICY}
}
module.exports={EXPIRY_ALERT_POLICY_KEY,DEFAULT_EXPIRY_ALERT_POLICY,validateExpiryAlertPolicy,expiryPolicyFromStored,getExpiryAlertPolicy}
