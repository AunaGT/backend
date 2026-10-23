const CONFIRMED_SALE_STATUS='Completada'
function commercialState(name){return ({Borrador:'DRAFT',Completada:'CONFIRMED',Cancelada:'CANCELLED'})[name]||'LEGACY'}
function confirmedSaleWhere(extra={}){return {AND:[{status:{name:CONFIRMED_SALE_STATUS}},extra]}}
function assertGenericSaleStatusChange(sale,target){
  const fail=(code,message)=>{throw Object.assign(Error(message),{code,status:409})}
  if(target==='Borrador')fail('INVALID_TRANSITION','Una venta registrada no puede convertirse en borrador')
  if(sale.settlement_source==='MANUAL_SALE'&&sale.status?.name!==target&&!(sale.status?.name==='Completada'&&target==='Cancelada'))
    fail('MANUAL_SALE_ACTION_REQUIRED','Gestiona este documento desde el editor de venta; no puede restaurarse con un cambio de estado')
  if((sale.origin_engagement_id||commercialState(sale.status?.name)==='DRAFT')&&sale.status?.name!==target)
    fail('ENGAGEMENT_OWNS_SALE','Gestiona esta venta desde su contratación de Agenda')
}
function saleCommercialView(sale,{fiscalEnabled}={}){
  return {state:commercialState(sale.status?.name),originEngagementId:sale.origin_engagement_id||null,version:sale.version||1,
    confirmedAt:sale.confirmed_at?new Date(sale.confirmed_at).toISOString():null,
    fiscalState:fiscalEnabled===false&&!sale.sale_dtes?.length?'DISABLED':require('./externalInvoices').fiscalState(sale.sale_dtes||[])}
}
module.exports={CONFIRMED_SALE_STATUS,commercialState,confirmedSaleWhere,saleCommercialView,assertGenericSaleStatusChange}
