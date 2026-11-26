const {randomUUID}=require('node:crypto')
const {Prisma}=require('@prisma/client')
const {DateTime}=require('luxon')
const {money,fail,planDisposition}=require('./disputes.domain')
const D=v=>new Prisma.Decimal(String(v??0))
const LIVE=['ABSORBED','RECEIPT_RETIRED','CUSTOMER_CHARGE']
// disputes.js requires this module; its helpers are read lazily to avoid a require cycle.
const helpers=()=>require('./disputes')

async function settings(db,companyId){
 const [s]=await db.$queryRaw`SELECT dispute_account_id,loss_account_id,receivables_account_id,advances_account_id FROM cash_dispute_settings WHERE company_id=${companyId}::uuid`
 return s||{}
}
async function frozenDisputeAccount(db,caseId){
 const [r]=await db.$queryRaw`SELECT payload#>>'{accounting,disputeAccountId}' AS id FROM cash_dispute_events
   WHERE dispute_id=${caseId}::uuid AND principal>0 AND kind IN('BANK_DEBIT','PROVIDER_WITHHOLDING','LEGACY_WITHHOLDING') ORDER BY created_at,id LIMIT 1`
 return r?.id==null?null:Number(r.id)
}
async function companyToday(db,companyId){
 return DateTime.now().setZone(await require('../../services/commercialPayment').getTimezone(db,companyId)).toISODate()
}
// Saldo libre del recibo que este expediente ya reserva: es lo único que se puede cancelar sin crear deuda.
async function heldReceipts(db,caseId){
 return db.$queryRaw`SELECT r.payment_id,r.held FROM customer_receipt_restrictions r JOIN customer_payments p ON p.id=r.payment_id
   WHERE r.dispute_id=${caseId}::uuid AND r.held>0 ORDER BY p.paid_at,p.id`
}

async function previewDisposition(db,scope,doc,raw,{issuedOn:storedIssuedOn}={}){
 const {fields,text,day}=helpers()
 fields(raw,['customerPrincipal','absorbedPrincipal','dueOn','reason'])
 if(!['PARTIALLY_LOST','LOST'].includes(doc.status))fail('DISPUTE_STATE_CONFLICT','Registra primero el resultado perdido del proveedor',409)
 const reason=text(raw.reason,'Motivo de la resolución',1000)
 const customer=money(raw.customerPrincipal??'0'),absorbed=money(raw.absorbedPrincipal??'0')
 const receipts=await heldReceipts(db,doc.id),free=receipts.reduce((s,r)=>s.add(r.held),D(0))
 const plan=planDisposition({lost:doc.lost,withdrawn:doc.withdrawn,recovered:doc.recovered,disposed:doc.disposed,free:free.toFixed(2),
   customerPrincipal:customer.toFixed(2),absorbedPrincipal:absorbed.toFixed(2),identifiedCustomer:!!doc.customerId})
 let left=D(plan.retired);const retirements=[]
 for(const r of receipts){const take=Prisma.Decimal.min(left,r.held);if(take.gt(0))retirements.push({paymentId:r.payment_id,amount:take.toFixed(2)});left=left.sub(take)}
 const issuedOn=storedIssuedOn??await companyToday(db,scope.companyId)
 let dueOn=null
 if(D(plan.charged).gt(0)){
  const customerRow=await db.supplier.findFirst({where:{id:doc.customerId,company_id:scope.companyId,party_type:'CUSTOMER',deleted:false},include:{supplier_payment_terms:require('../receivables').CUSTOMER_TERM_PICK}})
  if(!customerRow)fail('DISPUTE_CUSTOMER_REQUIRED','El cliente del cobro ya no está activo. No se puede emitir un cargo.',409)
  const netDays=customerRow.supplier_payment_terms[0]?.payment_term?.net_days
  dueOn=raw.dueOn?day(raw.dueOn,'Vencimiento del cargo'):netDays==null?null:DateTime.fromISO(issuedOn).plus({days:Number(netDays)}).toISODate()
  if(!dueOn)fail('DISPUTE_INPUT_INVALID','Indica el vencimiento del cargo o configura el plazo de crédito del cliente')
  if(dueOn<issuedOn)fail('DISPUTE_INPUT_INVALID','El vencimiento no puede ser anterior a la emisión del cargo')
 }
 const s=await settings(db,scope.companyId)
 const accounting={disputeAccountId:await frozenDisputeAccount(db,doc.id)??s.dispute_account_id??null,lossAccountId:s.loss_account_id??null,
   receivablesAccountId:s.receivables_account_id??null,advancesAccountId:s.advances_account_id??null}
 const issues=[]
 if(await require('./bankMethods').accountingEnabled(db,scope.companyId)){
  const need=[['disputeAccountId',true],['lossAccountId',D(plan.absorbed).gt(0)],['advancesAccountId',D(plan.retired).gt(0)],['receivablesAccountId',D(plan.charged).gt(0)]]
  if(need.some(([k,used])=>used&&!accounting[k]))fail('DISPUTE_ACCOUNTS_REQUIRED','Con contabilidad activa, configura las cuentas de fondos en disputa, pérdida, anticipos y clientes antes de resolver',409)
 }
 const payload={reason,customerPrincipal:customer.toFixed(2),absorbedPrincipal:absorbed.toFixed(2),issuedOn,dueOn,plan,retirements,accounting}
 return {payload,base:{receipts:receipts.map(r=>({paymentId:r.payment_id,held:D(r.held).toFixed(2)})),issuedOn},issues,
   after:{status:doc.status,won:doc.won,lost:doc.lost,charged:D(doc.charged).add(plan.charged).toFixed(2)}}
}

async function chargeReference(tx,scope){
 const [branch]=await tx.$queryRaw`SELECT code FROM branches WHERE id=${scope.branchId}::uuid`
 await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'dispute-charge:'+scope.companyId},0))::text`
 const prefix=`CC-${branch.code}-`
 const rows=await tx.$queryRaw`SELECT reference FROM customer_dispute_charges WHERE company_id=${scope.companyId}::uuid AND reference LIKE ${prefix+'%'}`
 const last=Math.max(0,...rows.map(r=>Number(r.reference.slice(prefix.length))).filter(Number.isSafeInteger))
 return prefix+String(last+1).padStart(6,'0')
}
// Se ejecuta con la propuesta ya aprobada y antes de cambiar la versión del expediente que la respalda.
async function applyApprovedDisposition(tx,scope,doc,proposal){
 const p=proposal.payload,a=p.accounting||{},lots=[]
 const lot=async(kind,principal,accountId,paymentId=null)=>{
  const id=randomUUID()
  await tx.$executeRaw`INSERT INTO cash_dispute_lots(id,dispute_id,company_id,branch_id,proposal_id,payment_id,kind,principal,account_id)
    VALUES(${id}::uuid,${doc.id}::uuid,${scope.companyId}::uuid,${scope.branchId}::uuid,${proposal.id}::uuid,${paymentId}::uuid,${kind},${principal}::numeric,${accountId})`
  lots.push({id,kind,principal});return id
 }
 for(const r of p.retirements)await lot('RECEIPT_RETIRED',r.amount,a.advancesAccountId,r.paymentId)
 let chargeId=null
 if(D(p.plan.charged).gt(0)){
  const lotId=await lot('CUSTOMER_CHARGE',p.plan.charged,a.receivablesAccountId)
  chargeId=randomUUID()
  await tx.$executeRaw`INSERT INTO customer_dispute_charges(id,dispute_id,lot_id,company_id,branch_id,customer_id,currency_code,reference,amount,issued_on,due_on,reason,created_by_id)
    VALUES(${chargeId}::uuid,${doc.id}::uuid,${lotId}::uuid,${scope.companyId}::uuid,${scope.branchId}::uuid,${doc.customerId}::uuid,${doc.currencyCode},${await chargeReference(tx,scope)},
      ${p.plan.charged}::numeric,${p.issuedOn}::date,${p.dueOn}::date,${p.reason},${scope.userId}::uuid)`
 }
 if(D(p.plan.absorbed).gt(0))await lot('ABSORBED',p.plan.absorbed,a.lossAccountId)
 return {lots,chargeId}
}

// Lotes vivos con su principal todavía no recuperado ni compensado, en el formato del plan puro.
async function recoveryLots(db,caseId){
 const rows=await db.$queryRaw`SELECT l.id,l.kind,l.payment_id,l.account_id,
   l.principal-coalesce((SELECT sum(x.principal) FROM cash_dispute_lots x WHERE x.target_lot_id=l.id AND x.kind IN('RECOVERED','COMPENSATED')),0) AS remaining
   FROM cash_dispute_lots l WHERE l.dispute_id=${caseId}::uuid AND l.kind=ANY(${LIVE}) ORDER BY l.id`
 return rows.map(r=>({id:r.id,kind:r.kind,paymentId:r.payment_id,accountId:r.account_id,remaining:D(r.remaining).toFixed(2)}))
}
// Saldo pendiente real del cargo: lo cobrado no se reduce otra vez; lo recuperado o compensado sí.
async function chargeOutstanding(db,lotId){
 const [c]=await db.$queryRaw`SELECT c.id,c.amount,
   coalesce((SELECT sum(CASE action WHEN 'APPLY' THEN amount ELSE -amount END) FROM customer_dispute_charge_applications WHERE charge_id=c.id),0)
   +coalesce((SELECT sum(CASE action WHEN 'APPLY' THEN amount ELSE -amount END) FROM customer_recovery_credit_applications WHERE charge_id=c.id),0) AS paid,
   coalesce((SELECT sum(x.principal) FROM cash_dispute_lots x WHERE x.target_lot_id=c.lot_id AND (x.kind='COMPENSATED'
     OR x.kind='RECOVERED' AND NOT EXISTS(SELECT 1 FROM customer_recovery_credits k WHERE k.lot_id=x.id))),0) AS reduced
   FROM customer_dispute_charges c WHERE c.lot_id=${lotId}::uuid`
 if(!c)fail('DISPUTE_CHARGE_MISSING','Falta el documento del cargo de esta resolución',409)
 return {chargeId:c.id,outstanding:Prisma.Decimal.max(0,D(c.amount).sub(c.paid).sub(c.reduced))}
}
// Recuperación sobre lo ya resuelto: reduce primero el cargo pendiente; lo ya pagado queda a favor del cliente.
async function applyRecoveryToLots(tx,scope,doc,eventId,plan,lots){
 const byId=new Map(lots.map(l=>[l.id,l])),{advances_account_id:advances}=await settings(tx,scope.companyId)
 const insert=async(target,principal,accountId)=>{
  const id=randomUUID()
  await tx.$executeRaw`INSERT INTO cash_dispute_lots(id,dispute_id,company_id,branch_id,event_id,target_lot_id,payment_id,kind,principal,account_id)
    VALUES(${id}::uuid,${doc.id}::uuid,${scope.companyId}::uuid,${scope.branchId}::uuid,${eventId}::uuid,${target.id}::uuid,${target.paymentId}::uuid,'RECOVERED',${principal.toFixed(2)}::numeric,${accountId})`
  return id
 }
 const credits=[]
 for(const part of plan){
  const target=byId.get(part.lotId),amount=money(part.amount)
  if(target.kind!=='CUSTOMER_CHARGE'){await insert(target,amount,target.accountId);continue}
  const {outstanding}=await chargeOutstanding(tx,target.id),reduce=Prisma.Decimal.min(amount,outstanding),credit=amount.sub(reduce)
  if(reduce.gt(0))await insert(target,reduce,target.accountId)
  if(credit.gt(0)){
   const lotId=await insert(target,credit,advances??null),id=randomUUID()
   await tx.$executeRaw`INSERT INTO customer_recovery_credits(id,dispute_id,event_id,lot_id,company_id,branch_id,customer_id,currency_code,amount,actor_id)
     VALUES(${id}::uuid,${doc.id}::uuid,${eventId}::uuid,${lotId}::uuid,${scope.companyId}::uuid,${scope.branchId}::uuid,${doc.customerId}::uuid,${doc.currencyCode},${credit.toFixed(2)}::numeric,${scope.userId}::uuid)`
   credits.push({id,amount:credit.toFixed(2)})
  }
 }
 return {credits}
}
// Condonar o corregir un lote ya resuelto: se compensa con un lote opuesto, nunca se edita ni se borra.
async function previewAdjustment(db,scope,doc,kind,raw){
 const {fields,text}=helpers()
 fields(raw,['lotId','amount','reason'])
 const reason=text(raw.reason,kind==='FORGIVE'?'Motivo de la condonación':'Motivo de la corrección',1000),amount=money(raw.amount)
 if(amount.lte(0))fail('DISPUTE_MONEY_INVALID','Indica el principal a compensar')
 const lot=(await recoveryLots(db,doc.id)).find(l=>l.id===String(raw.lotId).toLowerCase())
 if(!lot)fail('DISPUTE_NOT_FOUND','Resolución no encontrada en este expediente',404)
 if(kind==='FORGIVE'&&lot.kind!=='CUSTOMER_CHARGE')fail('DISPUTE_ACTION_INVALID','Solo se condona el saldo de un cargo al cliente',409)
 // Del cargo solo se compensa lo pendiente: lo cobrado ya pertenece al cliente.
 const limit=lot.kind==='CUSTOMER_CHARGE'?(await chargeOutstanding(db,lot.id)).outstanding:D(lot.remaining)
 if(amount.gt(limit))fail('DISPUTE_ADJUSTMENT_EXCEEDS',lot.kind==='CUSTOMER_CHARGE'?'Supera el saldo pendiente del cargo':'Supera el principal vigente de esa resolución',409)
 const s=await settings(db,scope.companyId)
 const accounting={disputeAccountId:await frozenDisputeAccount(db,doc.id)??s.dispute_account_id??null,lossAccountId:s.loss_account_id??null}
 if(kind==='FORGIVE'&&!accounting.lossAccountId&&await require('./bankMethods').accountingEnabled(db,scope.companyId))fail('DISPUTE_ACCOUNTS_REQUIRED','Con contabilidad activa, configura la cuenta de pérdida antes de condonar',409)
 const payload={reason,lotId:lot.id,lotKind:lot.kind,amount:amount.toFixed(2),issuedOn:await companyToday(db,scope.companyId),accounting,
   ...(kind==='FORGIVE'?{absorbedPrincipal:amount.toFixed(2)}:{})}
 const charged=lot.kind==='CUSTOMER_CHARGE'?D(doc.charged).sub(amount):D(doc.charged)
 return {payload,base:{lot:{id:lot.id,remaining:lot.remaining,limit:limit.toFixed(2)}},issues:[],after:{status:doc.status,won:doc.won,lost:doc.lost,charged:charged.toFixed(2)}}
}
async function applyApprovedAdjustment(tx,scope,doc,proposal){
 const p=proposal.payload,[target]=await tx.$queryRaw`SELECT id,payment_id,account_id FROM cash_dispute_lots WHERE id=${p.lotId}::uuid AND dispute_id=${doc.id}::uuid`
 await tx.$executeRaw`INSERT INTO cash_dispute_lots(id,dispute_id,company_id,branch_id,proposal_id,target_lot_id,payment_id,kind,principal,account_id)
   VALUES(${randomUUID()}::uuid,${doc.id}::uuid,${scope.companyId}::uuid,${scope.branchId}::uuid,${proposal.id}::uuid,${target.id}::uuid,${target.payment_id}::uuid,'COMPENSATED',${p.amount}::numeric,${target.account_id})`
 // Condonar convierte ese principal en pérdida asumida con su propia fuente.
 if(proposal.kind==='FORGIVE')await tx.$executeRaw`INSERT INTO cash_dispute_lots(id,dispute_id,company_id,branch_id,proposal_id,kind,principal,account_id)
   VALUES(${randomUUID()}::uuid,${doc.id}::uuid,${scope.companyId}::uuid,${scope.branchId}::uuid,${proposal.id}::uuid,'ABSORBED',${p.amount}::numeric,${p.accounting.lossAccountId})`
}
// Contrapartidas de recuperaciones ya repartidas en lotes: la parte pagada va a la cuenta del crédito, el resto a la raíz.
async function recoveryLotAccounts(db,eventIds){
 if(!eventIds.length)return []
 const rows=await db.$queryRaw`SELECT l.event_id,l.principal,CASE WHEN EXISTS(SELECT 1 FROM customer_recovery_credits k WHERE k.lot_id=l.id) THEN l.account_id ELSE r.account_id END AS account_id
   FROM cash_dispute_lots l JOIN cash_dispute_lots r ON r.id=l.target_lot_id WHERE l.event_id=ANY(${eventIds}::uuid[]) AND l.kind='RECOVERED' ORDER BY l.id`
 return rows.map(r=>({eventId:r.event_id,accountId:r.account_id,amount:D(r.principal)}))
}
module.exports={previewDisposition,previewAdjustment,applyApprovedDisposition,applyApprovedAdjustment,recoveryLots,chargeOutstanding,applyRecoveryToLots,recoveryLotAccounts,companyToday}
