const {Prisma}=require('@prisma/client')
const core=require('./core')
const fail=message=>{throw Object.assign(new Error(message),{status:409})}
const sum=rows=>rows.reduce((n,v)=>n.add(String(v)),new Prisma.Decimal(0))
async function load(db,scope,id,{legacyClosure,lock=false}={}) {
  const [c]=await db.$queryRaw`SELECT c.* FROM cash_closures c JOIN branches b ON b.id=c.branch_id WHERE c.id=${id}::uuid AND b.company_id=${scope.companyId}::uuid ${scope.branchId?Prisma.sql`AND c.branch_id=${scope.branchId}::uuid`:Prisma.empty} ${lock?Prisma.sql`FOR UPDATE OF c`:Prisma.empty}`
  if(!c||!['Aprobado','Cerrado'].includes(c.status))fail('Arqueo finalizado no encontrado')
  const flow=require('../../modules/cash-closure/corrections'),enabled=await flow.available(db)
  const approved=enabled?await db.$queryRaw`SELECT * FROM cash_closure_corrections WHERE closure_id=${id}::uuid AND status='APPROVED' ORDER BY sequence`:[]
  const base=enabled?await flow.baseFor(db,c):null
  let originalDelta
  if(base?.eligible) {
    const payments=await db.$queryRaw`SELECT p.id,p.actual_amount::text,p.theoretical_amount::text FROM cash_closure_payments p WHERE p.cash_closure_id=${id}::uuid`
    originalDelta=sum(payments.filter(p=>base.lines.find(l=>l.closurePaymentId===p.id)?.kind==='CASH').map(p=>new Prisma.Decimal(p.actual_amount).sub(p.theoretical_amount)))
  }else if(!approved.length&&legacyClosure?.payment_breakdowns?.length&&legacyClosure.payment_breakdowns.every(l=>['CASH','BANK'].includes(l.payment_method?.settlement_kind))) {
    originalDelta=sum(legacyClosure.payment_breakdowns.filter(l=>l.payment_method.settlement_kind==='CASH').map(l=>new Prisma.Decimal(String(l.actual_amount)).sub(String(l.theoretical_amount))))
  }else fail(base?.issue||'Arqueo sin desglose congelado verificable; requiere revisión')
  const sources=[{id:c.id,type:'CASH_CLOSURE',date:c.date,delta:originalDelta,description:`Diferencia de arqueo #${c.closure_number}`,doc:null}]
  for(const a of approved){
    const rows=await db.$queryRaw`SELECT delta::text FROM cash_closure_correction_lines WHERE correction_id=${a.id}::uuid AND settlement_kind='CASH'`
    sources.push({id:a.id,type:'CASH_CLOSURE_CORRECTION',date:a.accounting_date.toISOString().slice(0,10),delta:sum(rows.map(l=>l.delta)),description:`Corrección ${a.sequence} de arqueo #${c.closure_number}`,doc:a})
  }
  const entries=await db.journalEntry.findMany({where:{company_id:scope.companyId,OR:sources.map(s=>({source_type:s.type,source_id:s.id}))},include:{lines:true,reversals:{select:{id:true}}}})
  return {c,sources,entries}
}
function entryPair(entry,source,scope,branchId) {
  if(entry.branch_id!==branchId||entry.company_id!==scope.companyId||entry.reversal_of_id||entry.reversals?.length||source.delta.isZero()||entry.lines.length!==2)fail('El asiento de origen fue revertido o no coincide con el arqueo; requiere revisión contable')
  const amount=source.delta.abs(),positive=source.delta.gt(0)
  const debit=entry.lines.find(l=>new Prisma.Decimal(String(l.debit)).eq(amount)&&new Prisma.Decimal(String(l.credit)).isZero())
  const credit=entry.lines.find(l=>new Prisma.Decimal(String(l.credit)).eq(amount)&&new Prisma.Decimal(String(l.debit)).isZero())
  if(!debit||!credit||debit.account_id===credit.account_id)fail('La estructura del asiento de origen no permite verificar las cuentas de caja y diferencias')
  return {cash:positive?debit.account_id:credit.account_id,difference:positive?credit.account_id:debit.account_id}
}
async function frozenPair(db,scope,chain) {
  let pair=null
  for(const s of chain.sources){
    const entry=chain.entries.find(e=>e.source_type===s.type&&e.source_id===s.id)
    if(!entry){if(s.doc?.accounting_status==='POSTED')fail('Falta el asiento de una corrección contabilizada');continue}
    const p=entryPair(entry,s,scope,chain.c.branch_id)
    if(pair&&(pair.cash!==p.cash||pair.difference!==p.difference))fail('Los asientos anteriores no usan las mismas cuentas de caja y diferencias')
    pair=p
  }
  if(pair){
    const valid=await db.account.findMany({where:{company_id:scope.companyId,id:{in:[pair.cash,pair.difference]},active:true,is_group:false}})
    if(valid.length!==2)fail('Las cuentas congeladas están inactivas o no reciben movimientos; requiere revisión contable')
  }
  return pair
}
async function configuredPair(db,scope){
  const a=await core.getCashClosureAccounts(db,scope.companyId)
  if(a.cash.id===a.cashOverShort.id)fail('Caja y diferencias deben tener cuentas distintas')
  return {cash:a.cash.id,difference:a.cashOverShort.id}
}
async function inspectChain(db,scope,id,proposal) {
  const active=await require('../../modules/cash-closure/bankMethods').accountingEnabled(db,scope.companyId)
  const result={enabled:active,status:active?'READY':'DEFERRED',issues:[],willPostOriginal:false,pendingAdjustments:0}
  try{
    const chain=await load(db,scope,id),pair=await frozenPair(db,scope,chain)
    const missing=chain.sources.filter(s=>!s.delta.isZero()&&!chain.entries.some(e=>e.source_type===s.type&&e.source_id===s.id))
    if(proposal&&!new Prisma.Decimal(proposal.cashDelta).isZero())missing.push({type:'PROPOSED',date:proposal.accountingDate})
    result.willPostOriginal=missing.some(s=>s.type==='CASH_CLOSURE');result.pendingAdjustments=missing.filter(s=>s.type==='CASH_CLOSURE_CORRECTION').length
    if(active&&missing.length&&!pair)await configuredPair(db,scope)
    for(const s of missing){const key=core.periodKeyForDate(s.date),p=await db.accountingPeriod.findUnique({where:{company_id_year_month:{company_id:scope.companyId,...key}}});if(p?.status==='CLOSED')result.issues.push(`El período ${String(key.month).padStart(2,'0')}/${key.year} está cerrado`)}
  }catch(error){if(!error.status)throw error;result.issues.push(error.message)}
  result.issues=[...new Set(result.issues)];if(active&&result.issues.length)result.status='BLOCKED'
  return result
}
async function postClosureChain(tx,scope,id,options={}) {
  // All accounting paths use company → parent → periods, including manual reversal.
  await core.lockAccountingCompany(tx,scope.companyId)
  const chain=await load(tx,scope,id,{...options,lock:true})
  let pair=await frozenPair(tx,scope,chain),postedCount=0
  for(const s of chain.sources){
    let entry=chain.entries.find(e=>e.source_type===s.type&&e.source_id===s.id)
    if(s.delta.isZero()){
      if(s.doc?.accounting_status==='DEFERRED')await tx.$executeRaw`UPDATE cash_closure_corrections SET accounting_status='ZERO' WHERE id=${s.id}::uuid`
      continue
    }
    if(!entry){
      pair=pair||await configuredPair(tx,scope)
      const amount=s.delta.abs().toFixed(2),positive=s.delta.gt(0)
      entry=await core.createEntry(tx,{company_id:scope.companyId,branch_id:chain.c.branch_id,date:s.date,description:s.description,source_type:s.type,source_id:s.id,created_by:scope.userId,
        lines:[{account_id:pair.cash,debit:positive?amount:0,credit:positive?0:amount},{account_id:pair.difference,debit:positive?0:amount,credit:positive?amount:0}]})
      postedCount++
    }
    if(s.doc?.accounting_status==='DEFERRED')await tx.$executeRaw`UPDATE cash_closure_corrections SET accounting_status='POSTED',journal_entry_id=${entry.id}::uuid,cash_account_id=${pair.cash},difference_account_id=${pair.difference} WHERE id=${s.id}::uuid`
  }
  return {postedCount}
}
async function assertCashEntryReversible(tx,scope,entry) {
  if(entry.source_type==='CASH_CLOSURE_CORRECTION')fail('Las correcciones se compensan con otra corrección aprobada; no se anulan desde Contabilidad')
  if(entry.source_type!=='CASH_CLOSURE')return
  await core.lockAccountingCompany(tx,scope.companyId)
  await tx.$queryRaw`SELECT c.id FROM cash_closures c JOIN branches b ON b.id=c.branch_id WHERE c.id::text=${entry.source_id} AND b.company_id=${scope.companyId}::uuid FOR UPDATE OF c`
  if(await require('../../modules/cash-closure/corrections').available(tx)){
    const [r]=await tx.$queryRaw`SELECT EXISTS(SELECT 1 FROM cash_closure_corrections WHERE closure_id::text=${entry.source_id} AND status IN ('PENDING','APPROVED')) AS protected`
    if(r.protected)fail('Este arqueo tiene correcciones pendientes o aprobadas. Revisa sus documentos de corrección')
  }
}
module.exports={postClosureChain,inspectChain,assertCashEntryReversible}
