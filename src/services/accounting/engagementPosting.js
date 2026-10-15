const {money}=require('../../modules/receivables/domain/paymentAllocations')
const {resolveEffectiveModules}=require('../../modules/platform/registry')
const {AccountingError,lockAccountingCompany,getEngagementAccounts,createEntry}=require('./core')
const sources={RECEIVE:'CUSTOMER_ADVANCE',APPLY:'CUSTOMER_ADVANCE_APPLIED',REFUND:'CUSTOMER_PAYMENT_REFUND'}
function buildEngagementPosting(movement,accounts){
  if(!Object.hasOwn(sources,movement.kind))throw new AccountingError('Tipo de movimiento de anticipo inválido')
  const value=money(movement.amount)
  if(value.lte(0))throw new AccountingError('El movimiento debe ser mayor que cero')
  const amount=value.toNumber()
  if(movement.kind==='APPLY')return [{account_id:accounts.customerAdvances,debit:amount,credit:0},{account_id:accounts.receivables,debit:0,credit:amount}]
  const target=movement.isCash?accounts.cash:accounts.bank
  return movement.kind==='RECEIVE'?[{account_id:target,debit:amount,credit:0},{account_id:accounts.customerAdvances,debit:0,credit:amount}]
    :[{account_id:accounts.customerAdvances,debit:amount,credit:0},{account_id:target,debit:0,credit:amount}]
}
async function loadSource(tx,scope,movement){
  if(movement.kind==='RECEIVE'){
    const receipt=await tx.customerPayment.findFirst({where:{id:movement.id,kind:'PAYMENT',branch:{company_id:scope.companyId},commitments:{some:{company_id:scope.companyId}}},include:{payment_method:true}})
    if(!receipt)throw new AccountingError('Recibo de contratación no encontrado en la empresa')
    return {amount:receipt.amount.toFixed(2),date:receipt.paid_at,branchId:receipt.branch_id,actorId:receipt.registered_by,method:receipt.payment_method}
  }
  if(movement.kind==='APPLY'){
    const event=await tx.paymentAllocationEvent.findFirst({where:{id:movement.id,company_id:scope.companyId,action:{in:['APPLIED','RELEASED']}}})
    if(!event)throw new AccountingError('Aplicación de anticipo no encontrada en la empresa')
    return {amount:event.amount.toFixed(2),date:event.created_at,branchId:event.branch_id,actorId:event.actor_id}
  }
  const refund=await tx.customerPaymentRefund.findFirst({where:{id:movement.id,company_id:scope.companyId,status:'CONFIRMED'}})
  if(!refund)throw new AccountingError('Devolución efectiva de anticipo no encontrada en la empresa')
  const method=await tx.paymentMethod.findUnique({where:{id:refund.payment_method_id||0}})
  if(!method||method.is_credit)throw new AccountingError('Medio de devolución inválido')
  return {amount:refund.amount.toFixed(2),date:refund.confirmed_at,branchId:refund.branch_id,actorId:refund.registered_by,method}
}
async function postEngagementMovement(tx,scope,movement){
  if(!scope.companyId||!Object.hasOwn(sources,movement.kind))throw new AccountingError('Empresa y tipo de movimiento son obligatorios')
  const modules=resolveEffectiveModules(await tx.companyModule.findMany({where:{company_id:scope.companyId}}))
  if(!modules.find(m=>m.code==='accounting')?.effectiveEnabled)return null
  await lockAccountingCompany(tx,scope.companyId)
  const source=await loadSource(tx,scope,movement),sourceType=sources[movement.kind]
  if(scope.branchId&&scope.branchId!==source.branchId)throw new AccountingError('El movimiento pertenece a otra sucursal')
  const old=await tx.journalEntry.findFirst({where:{company_id:scope.companyId,source_type:sourceType,source_id:movement.id},select:{id:true}})
  if(old)return old.id
  const accounts=await getEngagementAccounts(tx,scope.companyId)
  const isCash=/efectivo|cash/.test(String(source.method?.name||'').toLowerCase().normalize('NFD').replace(/\p{M}/gu,''))
  const lines=buildEngagementPosting({kind:movement.kind,amount:source.amount,isCash},accounts)
  const entry=await createEntry(tx,{company_id:scope.companyId,branch_id:source.branchId,date:source.date,created_by:source.actorId,
    description:movement.kind==='RECEIVE'?'Anticipo de contratación':movement.kind==='APPLY'?'Aplicación de anticipo a venta':'Devolución efectiva de anticipo',source_type:sourceType,source_id:movement.id,lines})
  return entry.id
}
async function postPendingEngagementMovements(db,userId,companyId){
  const modules=resolveEffectiveModules(await db.companyModule.findMany({where:{company_id:companyId}}))
  if(!modules.find(m=>m.code==='accounting')?.effectiveEnabled)return {posted:0,skipped:[],hasMore:false}
  const candidates=await db.$queryRaw`
    WITH candidates AS (
      SELECT cp.id::text AS id,'RECEIVE' AS kind,'CUSTOMER_ADVANCE'::"JournalSourceType" AS source_type,cp.paid_at AS ord
      FROM customer_payments cp WHERE cp.kind='PAYMENT' AND EXISTS (SELECT 1 FROM payment_commitments c WHERE c.payment_id=cp.id AND c.company_id=${companyId}::uuid)
      UNION ALL SELECT e.id::text,'APPLY','CUSTOMER_ADVANCE_APPLIED'::"JournalSourceType",e.created_at FROM payment_allocation_events e WHERE e.company_id=${companyId}::uuid AND e.action IN ('APPLIED','RELEASED')
      UNION ALL SELECT r.id::text,'REFUND','CUSTOMER_PAYMENT_REFUND'::"JournalSourceType",r.confirmed_at FROM customer_payment_refunds r WHERE r.company_id=${companyId}::uuid AND r.status='CONFIRMED'
    ) SELECT c.id,c.kind FROM candidates c WHERE NOT EXISTS (SELECT 1 FROM journal_entries j WHERE j.company_id=${companyId}::uuid AND j.source_id=c.id AND j.source_type=c.source_type)
      ORDER BY c.ord,c.id LIMIT 500
  `
  let posted=0;const skipped=[]
  for(const candidate of candidates){
    try{const entry=await db.$transaction(tx=>postEngagementMovement(tx,{companyId,userId},candidate),{timeout:30000,maxWait:10000});if(entry)posted++}
    catch(error){if(error instanceof AccountingError)skipped.push({source:candidate.id,reason:error.message});else throw error}
  }
  return {posted,skipped,hasMore:candidates.length>=500}
}
module.exports={buildEngagementPosting,postEngagementMovement,postPendingEngagementMovements}
