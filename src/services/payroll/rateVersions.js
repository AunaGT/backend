const { DateTime } = require('luxon')
const { DEFAULT_RATES, getPayrollRates: readLegacyRates } = require('./rates')
const { hasPerm } = require('../../middlewares/tenant')
const { fail } = require('../../modules/hr/domain/validation')
const MONEY = new Set(['bonificacionIncentivo','isrDeduccionUnica','isrTramo1Limite','isrTramo2Fijo'])
const TX_OPTIONS = { maxWait:10000, timeout:30000 }

function validatePayrollRates(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(400,'Los parámetros de nómina no son válidos')
  const rates={}
  if(Object.keys(raw).some(key=>!Object.hasOwn(DEFAULT_RATES,key)))fail(400,'Hay parámetros de nómina desconocidos')
  for(const key of Object.keys(DEFAULT_RATES)) {
    const value=raw[key]
    if(!['number','string'].includes(typeof value)||(typeof value==='string'&&!value.trim()))fail(400,`Revisa el parámetro ${key}`)
    const n=Number(value),max=MONEY.has(key)?1e12:key==='horaExtraFactor'?10:1
    if(!Number.isFinite(n)||n<0||n>max||(key==='horaExtraFactor'&&n===0))fail(400,`Revisa el parámetro ${key}`)
    rates[key]=n
  }
  return rates
}
function dateOnly(value) {
  const raw=value instanceof Date?value.toISOString().slice(0,10):value
  if(typeof raw!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(raw))fail(400,'La fecha no es válida')
  const date=new Date(`${raw}T00:00:00Z`)
  if(!Number.isFinite(+date)||date.toISOString().slice(0,10)!==raw)fail(400,'La fecha no es válida')
  return date
}
const today=now=>dateOnly(DateTime.fromJSDate(now,{zone:'America/Guatemala'}).toISODate())
function reasonOf(value){if(typeof value!=='string'||!value.trim()||value.trim().length>1000)fail(400,'Indica un motivo de hasta 1000 caracteres');return value.trim()}
function requireRatesAccess(user,write=false){
  if(write?!(hasPerm(user,'settings.manage')&&hasPerm(user,'payroll.confirm')):!((hasPerm(user,'settings.view')||hasPerm(user,'settings.manage'))&&hasPerm(user,'payroll.view')))fail(403,'No tienes permisos para administrar estos parámetros de nómina')
}
async function lockRates(tx,companyId){await tx.$executeRaw`SELECT pg_advisory_xact_lock(910016::int, hashtext(${companyId})::int)`}
async function resolvePayrollRates(db,companyId,payDate){
  const day=dateOnly(payDate)
  const rows=await db.payrollRateVersion.findMany({where:{company_id:companyId},orderBy:{effective_from:'desc'}})
  const version=rows.filter(r=>!r.cancelled_at&&!r.is_baseline&&r.effective_from<=day).sort((a,b)=>+b.effective_from-+a.effective_from)[0]||rows.find(r=>r.is_baseline&&!r.cancelled_at)
  return version?{rates:validatePayrollRates(version.rates),versionId:version.id,source:version.is_baseline?'baseline':'version'}:{rates:await readLegacyRates(db,companyId),versionId:null,source:'legacy'}
}
async function publishPayrollRates(db,scope,input,now=new Date()){
  const effectiveFrom=dateOnly(input?.effectiveFrom),rates=validatePayrollRates(input?.rates),reason=reasonOf(input?.reason)
  if(effectiveFrom<today(now))fail(400,'La vigencia no puede ser retroactiva')
  return db.$transaction(async tx=>{
    await lockRates(tx,scope.companyId)
    const rows=await tx.payrollRateVersion.findMany({where:{company_id:scope.companyId}})
    if(rows.some(r=>!r.cancelled_at&&!r.is_baseline&&+r.effective_from===+effectiveFrom))fail(409,'Ya existe una versión para esa fecha')
    if(!rows.some(r=>r.is_baseline))await tx.payrollRateVersion.create({data:{company_id:scope.companyId,is_baseline:true,effective_from:null,rates:await readLegacyRates(tx,scope.companyId),reason:'Configuración heredada capturada',created_by:null}})
    return tx.payrollRateVersion.create({data:{company_id:scope.companyId,is_baseline:false,effective_from:effectiveFrom,rates,reason,created_by:scope.userId||null}})
  },TX_OPTIONS)
}
async function cancelPayrollRates(db,scope,id,input,now=new Date()){
  const reason=reasonOf(input?.reason)
  return db.$transaction(async tx=>{
    await lockRates(tx,scope.companyId)
    const row=await tx.payrollRateVersion.findFirst({where:{id,company_id:scope.companyId}})
    if(!row)fail(404,'Versión no encontrada')
    if(row.is_baseline||row.cancelled_at||row.effective_from<=today(now))fail(409,'Solo se puede cancelar una versión futura')
    if(await tx.payrollRun.count({where:{company_id:scope.companyId,rate_version_id:id}}))fail(409,'La versión ya fue aplicada a una planilla')
    return tx.payrollRateVersion.update({where:{id},data:{cancelled_at:now,cancelled_by:scope.userId||null,cancel_reason:reason}})
  },TX_OPTIONS)
}
function ratesForRun(run){if(!run.rates_snapshot)fail(409,'Esta planilla histórica no tiene copia de parámetros. Adopta explícitamente los parámetros antes de recalcular.');return validatePayrollRates(run.rates_snapshot.rates)}
async function lockPayrollRun(tx,{id,companyId,branchId},include){
  const rows=await tx.$queryRaw`SELECT id FROM payroll_runs WHERE id=${id}::uuid AND company_id=${companyId}::uuid AND branch_id=${branchId}::uuid FOR UPDATE`
  if(!rows.length)fail(404,'Planilla no encontrada')
  const run=await tx.payrollRun.findFirst({where:{id,company_id:companyId,branch_id:branchId},...(include?{include}:{})})
  if(!run)fail(404,'Planilla no encontrada')
  return run
}
const snapshotOf=resolved=>({...resolved,capturedAt:new Date().toISOString()})
module.exports={validatePayrollRates,dateOnly,requireRatesAccess,resolvePayrollRates,publishPayrollRates,cancelPayrollRates,lockPayrollRun,lockRates,ratesForRun,snapshotOf}
