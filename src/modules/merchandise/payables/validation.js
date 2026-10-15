const {DateTime}=require('luxon'),{toCents,fromCents,fail}=require('./money')
const UUID=/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i
function object(raw,keys){if(!raw||Array.isArray(raw)||typeof raw!=='object'||Object.keys(raw).some(k=>!keys.includes(k)))fail('Campos de pago inválidos')}
function uuid(value){if(typeof value!=='string'||!UUID.test(value))fail('Identificador inválido');return value}
function integer(value,min,max){if(!Number.isSafeInteger(value)||value<min||value>max)fail('Número entero inválido');return value}
function text(value,max,nullable=true){if(value==null&&nullable)return null;if(typeof value!=='string'||value.length>max)fail('Texto inválido');return value.trim()||null}
function amount(raw,zero=false){if(!['string','number'].includes(typeof raw))fail('Monto inválido');const cents=toCents(raw);if(cents>(10**12-1)||!zero&&cents===0)fail('Monto fuera de rango');return fromCents(cents)}
function reason(raw){const value=text(raw,500,false);if(!value||value.length<3)fail('Indica un motivo de al menos 3 caracteres');return value}
function parseSupplierPayment(raw,{allowMissingMethod=false}={}){
  object(raw,['requestKey','supplierId','amount','currencyCode','paidAt','paymentMethodId','reference','notes','applications'])
  const paid=typeof raw.paidAt==='string'&&/(Z|[+-]\d{2}:\d{2})$/.test(raw.paidAt)?DateTime.fromISO(raw.paidAt):null
  if(!paid?.isValid)fail('Fecha de pago inválida; incluye zona horaria')
  if(typeof raw.currencyCode!=='string'||!/^[A-Z]{3}$/.test(raw.currencyCode))fail('Moneda inválida')
  if(!Array.isArray(raw.applications)||!raw.applications.length||raw.applications.length>100)fail('Selecciona de 1 a 100 entradas')
  const seen=new Set(),applications=raw.applications.map(a=>{object(a,['incomingId','amount','expectedRevision']);const id=uuid(a.incomingId);if(seen.has(id))fail('Entrada repetida');seen.add(id);return{incomingId:id,amount:amount(a.amount),expectedRevision:integer(a.expectedRevision,0,2147483647)}})
  return{requestKey:uuid(raw.requestKey),supplierId:uuid(raw.supplierId),amount:amount(raw.amount),currencyCode:raw.currencyCode,paidAt:paid.toUTC().toISO(),paymentMethodId:allowMissingMethod&&raw.paymentMethodId===null?null:integer(raw.paymentMethodId,1,2147483647),reference:text(raw.reference,255),notes:text(raw.notes,2000),applications}
}
function parseCancellation(raw){object(raw,['reason']);return{reason:reason(raw.reason)}}
function parseHistoricalCorrection(raw){object(raw,['amount','expectedRevision','reason']);return{amount:amount(raw.amount,true),expectedRevision:integer(raw.expectedRevision,0,2147483647),reason:reason(raw.reason)}}
function parsePayableFilters(raw={},timezone='America/Guatemala',now=new Date()){
  object(raw,['search','supplierId','state','dateFrom','dateTo','dueFrom','dueTo','page','pageSize','entryPage','paymentPage','auditPage'])
  const result={search:text(raw.search??'',150)||'',state:raw.state||'OPEN',page:integer(Number(raw.page??1),1,2147483647),pageSize:integer(Number(raw.pageSize??10),1,100),localDay:DateTime.fromJSDate(now).setZone(timezone).toISODate(),timezone}
  if(!result.localDay)fail('Zona horaria inválida')
  if(!['OPEN','OVERDUE','UPCOMING','PAID','ALL','REVIEW'].includes(result.state))fail('Estado inválido')
  if(raw.supplierId)result.supplierId=uuid(raw.supplierId)
  for(const key of ['dateFrom','dateTo','dueFrom','dueTo'])if(raw[key]){if(typeof raw[key]!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(raw[key])||!DateTime.fromISO(raw[key]).isValid)fail('Fecha de filtro inválida');result[key]=raw[key]}
  if(result.dateFrom>result.dateTo||result.dueFrom>result.dueTo)fail('El intervalo de fechas está invertido')
  for(const key of ['entryPage','paymentPage','auditPage'])if(raw[key]!==undefined)result[key]=integer(Number(raw[key]),1,2147483647)
  return result
}
module.exports={parseSupplierPayment,parseCancellation,parseHistoricalCorrection,parsePayableFilters,uuid,object,amount}
