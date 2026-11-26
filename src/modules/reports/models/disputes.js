const { createReport, column: c, section: s, metric: m, chart } = require('../reportModel')
const STATUS={OPEN:'En preparación',SUBMITTED:'Respuesta presentada',WON:'Ganada',PARTIALLY_LOST:'Pérdida parcial',LOST:'Perdida',CANCELLED:'Cancelada'}
const sum=(rows,key)=>Math.round(rows.reduce((t,r)=>t+r[key],0)*100)/100
const MONEY=[['claimed','Reclamado'],['withdrawn','Retirado por el proveedor'],['recovered','Recuperado'],['loss','Pérdida asumida'],['charged','Cargo al cliente'],['credited','Crédito al cliente'],['fees','Comisiones']]
// Cada dimensión es otro hecho: no se suman entre sí como un gasto total.
function buildDisputesReport(data, meta) {
  const rows=(data.rows||[]).map(r=>({...r,status:STATUS[r.status]||r.status,case:r.id.slice(0,8).toUpperCase(),date:r.createdAt}))
  const byStatus=Object.entries(STATUS).map(([key,label])=>{const group=(data.rows||[]).filter(r=>r.status===key);return {status:label,count:group.length,...Object.fromEntries(MONEY.map(([k])=>[k,sum(group,k)]))}}).filter(r=>r.count>0)
  const money=MONEY.map(([id,label])=>c(id,label,'money'))
  return createReport(meta,{id:'disputes',title:'Disputas de cobros digitales',
    summary:[m('cases','Expedientes',rows.length),...MONEY.slice(0,6).map(([id,label])=>m(id,label,sum(rows,id),'money'))],
    sections:[s('detail','Expedientes del período',[c('date','Apertura','datetime'),c('case','Expediente'),c('providerReference','Referencia del proveedor'),c('status','Estado'),
      ...(meta.scope.branches.length>1?[c('branch','Sucursal')]:[]),c('customer','Cliente'),c('method','Medio'),...money],rows,Object.fromEntries(MONEY.map(([k])=>[k,sum(rows,k)]))),
      s('by-status','Por estado',[c('status','Estado'),c('count','Expedientes','integer'),...money],byStatus)],
    charts:[chart('by-status','Principal reclamado por estado',byStatus,'status','claimed')],
    notes:[data.available===false?'Las disputas todavía no están disponibles en esta instalación.':'Reclamado, retirado, recuperado, pérdida, cargo y crédito son dimensiones distintas: no se suman como un gasto total.',
      'Importes vigentes al preparar el reporte para los expedientes abiertos en el período. «Ganada» no afirma que el banco devolvió el dinero.']})
}
module.exports={buildDisputesReport}
