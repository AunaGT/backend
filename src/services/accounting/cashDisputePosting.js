const {Prisma}=require('@prisma/client')
const core=require('./core')
const {money,fail}=require('../../modules/cash-closure/disputes.domain')
const D=value=>new Prisma.Decimal(String(value??0))
const blocked=message=>fail('DISPUTE_ACCOUNTING_PROVENANCE',message,409)
function accountId(value){if(!Number.isSafeInteger(value)||value<=0)blocked('Falta una cuenta contable verificable en la procedencia del movimiento');return value}
function ledger(){
  const totals=new Map()
  return {add(id,amount){id=accountId(id);totals.set(id,(totals.get(id)||D(0)).add(amount))},lines(){return [...totals].sort(([a],[b])=>a-b).filter(([,v])=>!v.isZero()).map(([id,v])=>({account_id:id,debit:Prisma.Decimal.max(0,v).toFixed(2),credit:Prisma.Decimal.max(0,v.neg()).toFixed(2)}))}}
}
function buildDisputeEffectLines(event,accounts,recoveries=[]) {
  const principal=money(String(event.principal)),fee=money(String(event.fee)),result=ledger()
  if(principal.add(fee).lte(0))blocked('El movimiento no tiene un importe contable')
  if(['BANK_DEBIT','PROVIDER_WITHHOLDING','LEGACY_WITHHOLDING'].includes(event.kind)){
    if(principal.gt(0))result.add(accounts.dispute,principal)
    if(fee.gt(0))result.add(accounts.fee,fee)
    result.add(accounts.funding,principal.add(fee).neg())
  }else if(['BANK_RECOVERY','PROVIDER_RECOVERY'].includes(event.kind)){
    const disposed=recoveries.reduce((sum,r)=>sum.add(money(r.amount)),D(0))
    if(disposed.gt(principal))blocked('Los destinos de recuperación superan el principal recuperado')
    result.add(accounts.funding,principal.sub(fee))
    if(principal.gt(disposed))result.add(accounts.dispute,principal.sub(disposed).neg())
    for(const r of recoveries)result.add(r.accountId,money(r.amount).neg())
    if(fee.gt(0))result.add(accounts.fee,fee)
  }else blocked('Este movimiento requiere la ruta contable de su documento de compensación')
  return result.lines()
}
function buildDisputeDispositionLines(lots,disputeAccountId){
  const result=ledger()
  for(const lot of lots){
    const value=money(String(lot.principal))
    if(!['ABSORBED','RECEIPT_RETIRED','CUSTOMER_CHARGE','COMPENSATED'].includes(lot.kind)||value.lte(0))blocked('La resolución no conserva una distribución contable válida')
    const signed=lot.kind==='COMPENSATED'?value.neg():value
    result.add(lot.accountId,signed);result.add(disputeAccountId,signed.neg())
  }
  return result.lines()
}
async function context(db,scope,caseId){
  const {assertCommandScope}=require('../../modules/cash-closure/disputes.boundary')
  const s=assertCommandScope(scope)
  await require('../../modules/cash-closure/disputes.queries').requireAvailable(db)
  const [d]=await db.$queryRaw`SELECT d.*,o.source_type,o.source_id,m.account_id AS original_account_id,
    (SELECT value FROM system_settings WHERE company_id=d.company_id AND key='currency_code') AS current_currency FROM cash_payment_disputes d
    JOIN cash_money_events o ON o.id=d.event_id LEFT JOIN cash_bank_event_modes m ON m.event_id=o.id
    WHERE d.id::text=${String(caseId)} AND d.company_id=${s.companyId}::uuid AND d.branch_id=${s.branchId}::uuid`
  if(!d)fail('DISPUTE_NOT_FOUND','Expediente no encontrado',404)
  return d
}
function verifyCurrency(d){if(d.current_currency!==d.currency_code)blocked('La moneda de la empresa cambió. No se convierte automáticamente el movimiento original.')}
async function lockContext(tx,scope,caseId){
  const d=await context(tx,scope,caseId),boundary=require('../../modules/cash-closure/disputes.boundary')
  await boundary.lockDisputeResources(tx,scope,await boundary.discoverDisputeResources(tx,scope,{eventIds:[d.event_id]}))
  await tx.$queryRaw`SELECT id FROM cash_payment_disputes WHERE id=${d.id}::uuid FOR UPDATE`
  await core.lockAccountingCompany(tx,scope.companyId)
  return context(tx,scope,caseId)
}
async function validAccounts(db,scope,requirements){
  const ids=[...new Set(requirements.map(r=>accountId(r.id)))]
  const rows=await db.account.findMany({where:{id:{in:ids},company_id:scope.companyId,active:true,is_group:false}})
  for(const r of requirements)if(!rows.some(a=>a.id===r.id&&r.types.includes(a.type)))blocked('Una cuenta congelada falta, está inactiva o pertenece a otro tipo o empresa. Revisa la configuración contable.')
}
async function verifyDisputeAsset(db,d,id){
  const rows=await db.$queryRaw`SELECT DISTINCT payload#>>'{accounting,disputeAccountId}' AS account_id FROM cash_dispute_events
    WHERE dispute_id=${d.id}::uuid AND principal>0 AND kind IN('BANK_DEBIT','PROVIDER_WITHHOLDING','LEGACY_WITHHOLDING')`
  if(!rows.length||rows.some(r=>Number(r.account_id)!==id))blocked('La cuenta de fondos en disputa no coincide con la procedencia congelada de sus retiros')
}
async function checkedEffectAccounts(db,scope,d,source){
  const frozen=source.payload?.accounting||{},accounts={dispute:frozen.disputeAccountId,funding:frozen.fundingAccountId,fee:frozen.feeAccountId}
  const legacyExpense=source.kind==='LEGACY_WITHHOLDING'&&accounts.funding!==accounts.dispute
  const required=[{id:accounts.dispute,types:['ASSET']},{id:accounts.funding,types:legacyExpense?['EXPENSE']:['ASSET']}]
  if(D(source.fee).gt(0))required.push({id:accounts.fee,types:['EXPENSE']})
  await validAccounts(db,scope,required)
  if(D(source.principal).gt(0))await verifyDisputeAsset(db,d,accounts.dispute)
  return accounts
}
async function originalEntry(db,scope,d){
  const entries=await db.journalEntry.findMany({where:{company_id:scope.companyId,branch_id:d.branch_id,source_id:d.source_id,
    source_type:{in:d.source_type==='SALE'?['SALE']:['SALE_PAYMENT','CUSTOMER_ADVANCE']}},include:{lines:true,reversals:{select:{id:true}}}})
  const [origin]=await db.$queryRaw`SELECT amount FROM cash_money_events WHERE id=${d.event_id}::uuid`
  if(entries.length!==1||entries[0].reversal_of_id||entries[0].reversals.length||!d.original_account_id)blocked('Falta contabilizar o verificar el cobro original. Resuelve su contabilidad antes de continuar.')
  const entry=entries[0],funds=entry.lines.filter(l=>l.account_id===d.original_account_id).reduce((sum,l)=>sum.add(l.debit).sub(l.credit),D(0))
  if(!funds.eq(origin.amount))blocked('El asiento del cobro no coincide con la cuenta e importe congelados. Requiere revisión contable.')
  return entry
}
function postingDate(source,options){
  const value=options?.accountingDate
  require('../../modules/cash-closure/disputes').day(value,'Fecha contable')
  const economic=source.economic_on?new Date(source.economic_on).toISOString().slice(0,10):null
  const reason=options?.dateChangeReason?.trim()||null
  if(economic&&economic!==value&&(!reason||reason.length>1000))blocked('Explica por qué la fecha contable es distinta de la fecha efectiva del banco')
  return {value,reason}
}
async function existingEntry(db,scope,type,id){
  const entry=await db.journalEntry.findFirst({where:{company_id:scope.companyId,source_type:type,source_id:id},include:{lines:true,reversals:{select:{id:true}}}})
  if(entry&&(entry.branch_id!==scope.branchId||entry.reversal_of_id||entry.reversals.length))blocked('El asiento de esta fuente fue revertido o pertenece a otra sucursal. Usa una compensación desde el expediente.')
  return entry
}
async function recoveryDestinations(tx,scope,d,e){
  const rows=await tx.$queryRaw`SELECT l.*,r.kind AS root_kind,r.account_id AS root_account_id,r.proposal_id AS root_proposal_id,
    coalesce((SELECT sum(amount) FROM customer_recovery_credits WHERE lot_id=l.id AND event_id=l.event_id),0) AS credit
    FROM cash_dispute_lots l JOIN cash_dispute_lots r ON r.id=l.target_lot_id WHERE l.event_id=${e.id}::uuid AND l.kind='RECOVERED' ORDER BY l.id`
  const result=[]
  for(const r of rows){
    const parent=await existingEntry(tx,scope,'CASH_DISPUTE_DISPOSITION',r.root_proposal_id)||await existingEntry(tx,scope,'CASH_DISPUTE_ADJUSTMENT',r.root_proposal_id)
    if(!parent)blocked('Contabiliza la resolución anterior antes de esta recuperación')
    let target=r.root_account_id
    if(r.root_kind==='CUSTOMER_CHARGE'&&D(r.credit).gt(0)){
      if(!D(r.credit).eq(r.principal))blocked('La recuperación pagada y la pendiente deben conservar lotes contables separados')
      target=accountId(r.account_id)
      await validAccounts(tx,scope,[{id:target,types:['LIABILITY']}])
    }else if(D(r.credit).gt(0))blocked('Este lote no puede producir un crédito adicional del cliente')
    result.push({accountId:accountId(target),amount:D(r.principal).toFixed(2)})
  }
  return result
}
async function verifySettlementEffect(tx,scope,d,e){
  const [source]=await tx.$queryRaw`SELECT x.*,s.journal_entry_id,s.status,s.currency_code,s.branch_id,s.company_id,s.net,b.payment_method_id,b.deposited_on,v.bank_account_id
    FROM cash_settlement_deductions x JOIN cash_settlements s ON s.id=x.settlement_id JOIN cash_bank_deposits b ON b.id=s.deposit_id
    JOIN cash_bank_method_versions v ON v.id=b.version_id WHERE x.id=${e.deduction_id}::uuid AND s.id=${e.settlement_id}::uuid`
  if(!source||source.company_id!==scope.companyId||source.branch_id!==scope.branchId||source.currency_code!==d.currency_code||source.payment_method_id!==d.payment_method_id||source.status!=='POSTED'
    ||source.kind!=='CHARGEBACK'||source.event_id!==d.event_id||!D(source.amount).eq(e.principal)||!D(e.fee).isZero()||source.account_id!==e.payload?.accounting?.fundingAccountId)blocked('La deducción y su liquidación no conservan una procedencia verificable para este expediente')
  const entry=await existingEntry(tx,scope,'CASH_SETTLEMENT',source.settlement_id)
  if(!entry||entry.id!==source.journal_entry_id)blocked('Falta contabilizar o verificar la liquidación original antes de vincular su efecto contable')
  const allocations=await tx.$queryRaw`SELECT a.amount,m.account_id FROM cash_settlement_allocations a JOIN cash_bank_event_modes m ON m.event_id=a.event_id WHERE a.settlement_id=${source.settlement_id}::uuid`
  const deductions=await tx.$queryRaw`SELECT amount,account_id FROM cash_settlement_deductions WHERE settlement_id=${source.settlement_id}::uuid`
  const expected=ledger(),actual=ledger()
  expected.add(source.bank_account_id,D(source.net))
  for(const row of allocations)expected.add(row.account_id,D(row.amount).neg())
  for(const row of deductions)expected.add(row.account_id,D(row.amount))
  const recoveries=await tx.$queryRaw`SELECT id,principal,payload#>>'{accounting,disputeAccountId}' AS account_id FROM cash_dispute_events WHERE settlement_id=${source.settlement_id}::uuid AND kind='PROVIDER_RECOVERY'`
  const lots=await require('../../modules/cash-closure/disputes.resolutions').recoveryLotAccounts(tx,recoveries.map(r=>r.id))
  for(const row of recoveries){
    const mine=lots.filter(l=>l.eventId===row.id)
    expected.add(Number(row.account_id),D(row.principal).sub(mine.reduce((s,l)=>s.add(l.amount),D(0))).neg())
    for(const l of mine)expected.add(l.accountId,l.amount.neg())
  }
  for(const line of entry.lines)actual.add(line.account_id,D(line.debit).sub(line.credit))
  if(!allocations.length||JSON.stringify(expected.lines())!==JSON.stringify(actual.lines())||new Date(entry.date).toISOString().slice(0,10)!==new Date(source.deposited_on).toISOString().slice(0,10))blocked('El asiento de la liquidación no coincide con todos sus cobros, deducciones y depósito. Requiere revisión contable.')
  return {source,entry}
}
async function postDisputeEffect(tx,scope,effectId,options={}){
  const [source]=await tx.$queryRaw`SELECT e.* FROM cash_dispute_events e JOIN cash_payment_disputes d ON d.id=e.dispute_id
    WHERE e.id::text=${String(effectId)} AND d.company_id=${scope.companyId}::uuid AND d.branch_id=${scope.branchId}::uuid`
  if(!source)fail('DISPUTE_NOT_FOUND','Movimiento no encontrado',404)
  const d=await lockContext(tx,scope,source.dispute_id)
  if(!await require('../../modules/cash-closure/bankMethods').accountingEnabled(tx,scope.companyId))return {entryId:null,status:'DEFERRED'}
  verifyCurrency(d)
  const old=await existingEntry(tx,scope,'CASH_DISPUTE_EFFECT',source.id)
  if(old)return {entryId:old.id,status:'POSTED'}
  await originalEntry(tx,scope,d)
  const accounts=await checkedEffectAccounts(tx,scope,d,source)
  if(source.settlement_id){
    if(!['LEGACY_WITHHOLDING','PROVIDER_WITHHOLDING'].includes(source.kind))blocked('Esta fuente necesita la ruta contable de su liquidación')
    const {entry}=await verifySettlementEffect(tx,scope,d,source)
    if(source.payload?.accounting?.fundingAccountId===source.payload?.accounting?.disputeAccountId){
      const date=new Date(entry.date).toISOString().slice(0,10)
      if(source.accounting_status==='DEFERRED'&&options.accountingDate&&options.accountingDate!==date)blocked('La deducción ya está contabilizada en la fecha de su liquidación. Conserva esa fecha al vincular el asiento original.')
      if(source.accounting_status==='DEFERRED')await tx.$executeRaw`UPDATE cash_dispute_events SET journal_entry_id=${entry.id}::uuid,accounting_status='INTEGRATED',accounting_on=${date}::date WHERE id=${source.id}::uuid`
      return {entryId:entry.id,status:'INTEGRATED'}
    }
    if(source.kind!=='LEGACY_WITHHOLDING')blocked('La deducción integrada debe usar la cuenta congelada de fondos en disputa')
  }
  if(accounts.dispute===accounts.funding)blocked('Fondos en disputa y banco deben usar cuentas diferentes')
  const targets=await recoveryDestinations(tx,scope,d,source),date=postingDate(source,options)
  const lines=buildDisputeEffectLines(source,accounts,targets)
  const entry=await core.createEntry(tx,{company_id:scope.companyId,branch_id:d.branch_id,date:date.value,created_by:scope.userId,
    source_type:'CASH_DISPUTE_EFFECT',source_id:source.id,description:`Disputa ${d.provider_reference} · ${source.kind}`,lines})
  await tx.$executeRaw`UPDATE cash_dispute_events SET journal_entry_id=${entry.id}::uuid,accounting_status='POSTED',accounting_on=${date.value}::date,accounting_reason=${date.reason} WHERE id=${source.id}::uuid`
  return {entryId:entry.id,status:'POSTED'}
}
async function retiredCounterpart(tx,scope,d,lot,base){
  const [alias]=await tx.$queryRaw`SELECT r.id FROM cash_refund_allocations a JOIN return_settlements rs ON rs.id=a.source_id JOIN returns r ON r.id=rs.return_id
    WHERE a.payment_id=${lot.payment_id}::uuid AND a.action='TRANSFER' AND a.origin_event_id=${d.event_id}::uuid`
  const source=alias?await existingEntry(tx,scope,'RETURN',alias.id):base
  if(!source||!source.lines.some(l=>l.account_id===lot.account_id&&D(l.credit).sub(l.debit).gte(lot.principal)))blocked('Falta el asiento que respalda el saldo cancelado de este recibo')
}
async function postDisputeDisposition(tx,scope,proposalId,options={}){
  const [p]=await tx.$queryRaw`SELECT p.* FROM cash_dispute_proposals p JOIN cash_payment_disputes d ON d.id=p.dispute_id
    WHERE p.id::text=${String(proposalId)} AND d.company_id=${scope.companyId}::uuid AND d.branch_id=${scope.branchId}::uuid`
  if(!p)fail('DISPUTE_NOT_FOUND','Resolución no encontrada',404)
  const d=await lockContext(tx,scope,p.dispute_id)
  if(!await require('../../modules/cash-closure/bankMethods').accountingEnabled(tx,scope.companyId))return {entryId:null,status:'DEFERRED'}
  verifyCurrency(d)
  if(p.status!=='APPROVED'||!['DISPOSITION','FORGIVE','CORRECT','COMPENSATE'].includes(p.kind))blocked('La resolución necesita una aprobación válida antes de contabilizarse')
  const type=p.kind==='DISPOSITION'?'CASH_DISPUTE_DISPOSITION':'CASH_DISPUTE_ADJUSTMENT',old=await existingEntry(tx,scope,type,p.id)
  if(old)return {entryId:old.id,status:'POSTED'}
  const base=await originalEntry(tx,scope,d),disputeId=accountId(p.payload?.accounting?.disputeAccountId)
  await verifyDisputeAsset(tx,d,disputeId)
  await validAccounts(tx,scope,[{id:disputeId,types:['ASSET']}])
  const [pending]=await tx.$queryRaw`SELECT EXISTS(SELECT 1 FROM cash_dispute_events WHERE dispute_id=${d.id}::uuid AND kind IN('BANK_DEBIT','PROVIDER_WITHHOLDING','LEGACY_WITHHOLDING') AND accounting_status NOT IN('POSTED','INTEGRATED')) AS needed`
  if(pending.needed)blocked('Contabiliza los retiros que respaldan esta resolución antes de continuar')
  const roots=await tx.$queryRaw`SELECT l.*,r.account_id AS target_account_id,r.proposal_id AS target_proposal_id FROM cash_dispute_lots l LEFT JOIN cash_dispute_lots r ON r.id=l.target_lot_id WHERE l.proposal_id=${p.id}::uuid ORDER BY l.id`
  if(!roots.length)blocked('La resolución no conserva sus lotes de principal')
  const lines=[]
  for(const lot of roots){
    const id=accountId(lot.kind==='COMPENSATED'?lot.target_account_id:lot.account_id)
    if(id===disputeId)blocked('La contrapartida debe ser distinta de fondos en disputa')
    if(lot.kind==='COMPENSATED'){
      const parent=await existingEntry(tx,scope,'CASH_DISPUTE_DISPOSITION',lot.target_proposal_id)||await existingEntry(tx,scope,'CASH_DISPUTE_ADJUSTMENT',lot.target_proposal_id)
      if(!parent)blocked('Contabiliza la resolución que se está corrigiendo antes de su compensación')
    }else if(lot.kind==='RECEIPT_RETIRED'){
      await validAccounts(tx,scope,[{id,types:['ASSET','LIABILITY']}]);await retiredCounterpart(tx,scope,d,lot,base)
    }else if(lot.kind==='CUSTOMER_CHARGE'){
      if(id!==p.payload?.accounting?.receivablesAccountId)blocked('El cargo no conserva su cuenta de clientes aprobada')
      await validAccounts(tx,scope,[{id,types:['ASSET']}])
      const [charge]=await tx.$queryRaw`SELECT amount FROM customer_dispute_charges WHERE lot_id=${lot.id}::uuid AND dispute_id=${d.id}::uuid`
      if(!charge||!D(charge.amount).eq(lot.principal))blocked('Falta el documento del cargo que respalda esta resolución')
    }else await validAccounts(tx,scope,[{id,types:['EXPENSE']}])
    lines.push({kind:lot.kind,principal:String(lot.principal),accountId:id})
  }
  const date=postingDate({},options),built=buildDisputeDispositionLines(lines,disputeId)
  if(!built.length)blocked('La resolución no produce un ajuste contable verificable')
  const entry=await core.createEntry(tx,{company_id:scope.companyId,branch_id:d.branch_id,date:date.value,created_by:scope.userId,source_type:type,source_id:p.id,description:`Resolución de disputa ${d.provider_reference}`,lines:built})
  await tx.$executeRaw`INSERT INTO cash_dispute_events(dispute_id,company_id,branch_id,kind,payload,accounting_status,actor_id) VALUES(${d.id}::uuid,${scope.companyId}::uuid,${scope.branchId}::uuid,'COMMUNICATION',${JSON.stringify({action:'DISPOSITION_POSTED',proposalId:p.id,entryId:entry.id,accountingDate:date.value,dateChangeReason:date.reason})}::jsonb,'ZERO',${scope.userId}::uuid)`
  return {entryId:entry.id,status:'POSTED'}
}
async function postDisputeChain(tx,scope,caseId,{accountingDateBySource={}}={}){
  if(!scope.can?.post)fail('DISPUTE_FORBIDDEN','Necesitas permiso contable para contabilizar fuentes pendientes',403)
  const d=await lockContext(tx,scope,caseId)
  if(!await require('../../modules/cash-closure/bankMethods').accountingEnabled(tx,scope.companyId))return {status:'DEFERRED',entries:[]}
  verifyCurrency(d)
  const events=await tx.$queryRaw`SELECT id,kind FROM cash_dispute_events WHERE dispute_id=${d.id}::uuid AND kind IN('BANK_DEBIT','PROVIDER_WITHHOLDING','LEGACY_WITHHOLDING','BANK_RECOVERY','PROVIDER_RECOVERY','COMPENSATION') ORDER BY created_at,id`
  const lots=await tx.$queryRaw`SELECT l.id,l.kind,l.proposal_id,l.event_id,l.target_lot_id,r.proposal_id AS parent_proposal_id FROM cash_dispute_lots l LEFT JOIN cash_dispute_lots r ON r.id=l.target_lot_id WHERE l.dispute_id=${d.id}::uuid ORDER BY l.created_at,l.id`
  const nodes=new Map(events.map(e=>[e.id,{id:e.id,type:'EFFECT',dependencies:lots.filter(l=>l.event_id===e.id).map(l=>l.parent_proposal_id).filter(Boolean)}]))
  for(const l of lots.filter(l=>l.proposal_id)){
    if(!nodes.has(l.proposal_id))nodes.set(l.proposal_id,{id:l.proposal_id,type:'DISPOSITION',dependencies:events.filter(e=>['BANK_DEBIT','PROVIDER_WITHHOLDING','LEGACY_WITHHOLDING'].includes(e.kind)).map(e=>e.id)})
    if(l.parent_proposal_id)nodes.get(l.proposal_id).dependencies.push(l.parent_proposal_id)
  }
  const done=new Set(),visiting=new Set(),entries=[]
  async function visit(id){
    if(done.has(id))return
    const node=nodes.get(id)
    if(!node||visiting.has(id))blocked('La cadena contable tiene dependencias que requieren revisión')
    visiting.add(id);for(const parent of new Set(node.dependencies))await visit(parent)
    const result=await(node.type==='EFFECT'?postDisputeEffect:postDisputeDisposition)(tx,scope,id,accountingDateBySource[id]||{})
    entries.push({sourceId:id,...result});visiting.delete(id);done.add(id)
  }
  for(const node of nodes.values())await visit(node.id)
  return {status:'POSTED',entries}
}
const ownSources=['CASH_DISPUTE_EFFECT','CASH_DISPUTE_DISPOSITION','CASH_DISPUTE_ADJUSTMENT']
async function inspectDisputeAccounting(db,scope,caseId){
  const doc=await require('../../modules/cash-closure/disputes.queries').getDispute(db,scope,caseId)
  const s={...scope,branchId:doc.branchId},d=await context(db,s,doc.id),enabled=await require('../../modules/cash-closure/bankMethods').accountingEnabled(db,s.companyId)
  const effects=await db.$queryRaw`SELECT e.id,e.kind,e.principal,e.fee,e.economic_on,e.accounting_on,e.accounting_status,e.journal_entry_id,e.accounting_reason,e.payload,e.settlement_id,e.deduction_id,j.entry_number,b.reference AS settlement_reference
    FROM cash_dispute_events e LEFT JOIN journal_entries j ON j.id=e.journal_entry_id AND j.company_id=e.company_id AND j.branch_id=e.branch_id
    LEFT JOIN cash_settlements st ON st.id=e.settlement_id AND st.company_id=e.company_id AND st.branch_id=e.branch_id LEFT JOIN cash_bank_deposits b ON b.id=st.deposit_id
    WHERE e.dispute_id=${d.id}::uuid AND e.kind IN('BANK_DEBIT','PROVIDER_WITHHOLDING','LEGACY_WITHHOLDING','BANK_RECOVERY','PROVIDER_RECOVERY','COMPENSATION') ORDER BY e.created_at,e.id`
  const resolutions=await db.$queryRaw`SELECT p.id,p.kind,p.proposed_at,j.id AS journal_entry_id,j.entry_number,j.date AS accounting_on
    FROM cash_dispute_proposals p LEFT JOIN journal_entries j ON j.source_id=p.id::text AND j.source_type IN('CASH_DISPUTE_DISPOSITION','CASH_DISPUTE_ADJUSTMENT') AND j.company_id=p.company_id AND j.branch_id=p.branch_id
    WHERE p.dispute_id=${d.id}::uuid AND p.status='APPROVED' AND EXISTS(SELECT 1 FROM cash_dispute_lots l WHERE l.proposal_id=p.id) ORDER BY p.proposed_at,p.id`
  const issues=[]
  if(enabled&&d.current_currency!==d.currency_code)issues.push('La moneda de la empresa cambió. El movimiento original requiere revisión contable, sin conversión automática.')
  if(enabled)try{await originalEntry(db,s,d)}catch(e){if(!e.status)throw e;issues.push(e.message)}
  for(const e of effects.filter(e=>e.accounting_status==='DEFERRED')){
    if(!e.payload?.accounting?.disputeAccountId||!e.payload?.accounting?.fundingAccountId)issues.push('Un movimiento no conserva sus cuentas de procedencia. Requiere revisión antes de contabilizarse.')
    if(enabled)try{await checkedEffectAccounts(db,s,d,e)}catch(error){if(!error.status)throw error;issues.push(error.message)}
    if(enabled&&e.settlement_id)try{await verifySettlementEffect(db,s,d,e)}catch(error){if(!error.status)throw error;issues.push(error.message)}
    if(e.kind==='COMPENSATION')issues.push('Hay una compensación que requiere su conciliación contable específica.')
  }
  const civil=v=>v?new Date(v).toISOString().slice(0,10):null
  const sources=[...effects.map(e=>({id:e.id,kind:e.kind,status:e.accounting_status,economicOn:civil(e.economic_on),accountingOn:civil(e.accounting_on),entryId:e.journal_entry_id,entryNumber:e.entry_number,dateChangeReason:e.accounting_reason,
    suggestedAccountingOn:e.accounting_status==='DEFERRED'?e.payload?.requestedAccountingDate??null:null,suggestedDateChangeReason:e.accounting_status==='DEFERRED'?e.payload?.requestedDateReason??null:null,
    settlementId:e.settlement_id,settlementReference:e.settlement_reference??null,
    accountingRoute:e.settlement_id?(e.kind==='LEGACY_WITHHOLDING'&&e.payload?.accounting?.fundingAccountId!==e.payload?.accounting?.disputeAccountId?'RECLASSIFICATION':'SETTLEMENT'):'STANDALONE'})),
    ...resolutions.map(p=>({id:p.id,kind:p.kind,status:p.journal_entry_id?'POSTED':'DEFERRED',economicOn:null,accountingOn:civil(p.accounting_on),entryId:p.journal_entry_id,entryNumber:p.entry_number}))]
  return {enabled,status:!enabled?'DEFERRED':issues.length?'BLOCKED':'READY',issues:[...new Set(issues)],sources}
}
async function prepareDisputeEntryReversal(tx,scope,entry){
  if(ownSources.includes(entry.source_type))fail('DISPUTE_ACCOUNTING_PROTECTED','Este asiento se compensa desde su expediente de disputa; conserva sus movimientos y saldos vinculados.',409)
  if(!await require('../../modules/cash-closure/disputes.queries').disputesAvailable(tx))return null
  const types={SALE:'SALE',SALE_PAYMENT:'CUSTOMER_PAYMENT',CUSTOMER_ADVANCE:'CUSTOMER_PAYMENT'}
  let rows=[]
  if(types[entry.source_type])rows=await tx.$queryRaw`SELECT id FROM cash_money_events WHERE company_id=${scope.companyId}::uuid AND source_type=${types[entry.source_type]} AND source_id::text=${entry.source_id} AND direction='IN' AND settlement_kind='BANK'`
  else if(entry.source_type==='CASH_SETTLEMENT')rows=await tx.$queryRaw`SELECT event_id AS id FROM cash_settlement_allocations WHERE settlement_id::text=${entry.source_id}
    UNION SELECT event_id FROM cash_settlement_deductions WHERE settlement_id::text=${entry.source_id} AND event_id IS NOT NULL
    UNION SELECT d.event_id FROM cash_dispute_events e JOIN cash_payment_disputes d ON d.id=e.dispute_id WHERE e.settlement_id::text=${entry.source_id}`
  else if(entry.source_type==='RETURN')rows=await tx.$queryRaw`SELECT e.id FROM cash_money_events e JOIN returns r ON e.source_type='SALE' AND e.source_id=r.sale_id WHERE r.id::text=${entry.source_id} AND e.company_id=${scope.companyId}::uuid
    UNION SELECT a.origin_event_id FROM cash_refund_allocations a JOIN return_settlements rs ON a.source_type='RETURN_SETTLEMENT' AND a.source_id=rs.id WHERE rs.return_id::text=${entry.source_id} AND a.company_id=${scope.companyId}::uuid AND a.origin_event_id IS NOT NULL
    UNION SELECT o.origin_id FROM payment_allocation_events a JOIN return_settlements rs ON rs.id=a.return_settlement_id CROSS JOIN LATERAL cash_dispute_receipt_origins(a.payment_id) o WHERE rs.return_id::text=${entry.source_id} AND a.company_id=${scope.companyId}::uuid`
  else if(entry.source_type==='CUSTOMER_PAYMENT_REFUND')rows=await tx.$queryRaw`SELECT o.origin_id AS id FROM customer_payment_refunds r CROSS JOIN LATERAL cash_dispute_receipt_origins(r.payment_id) o WHERE r.id::text=${entry.source_id} AND r.company_id=${scope.companyId}::uuid`
  else if(entry.source_type==='CUSTOMER_ADVANCE_APPLIED')rows=await tx.$queryRaw`SELECT o.origin_id AS id FROM payment_allocation_events a CROSS JOIN LATERAL cash_dispute_receipt_origins(a.payment_id) o WHERE a.id::text=${entry.source_id} AND a.company_id=${scope.companyId}::uuid`
  if(!rows.length)return null
  const branches=await tx.$queryRaw`SELECT DISTINCT branch_id FROM cash_money_events WHERE id=ANY(${rows.map(r=>r.id)}::uuid[]) AND company_id=${scope.companyId}::uuid`
  const branchId=entry.branch_id||(branches.length===1?branches[0].branch_id:null)
  if(!branchId)blocked('El asiento no conserva una sucursal verificable para su cobro original')
  const s={...scope,branchId},boundary=require('../../modules/cash-closure/disputes.boundary')
  const resources=await boundary.discoverDisputeResources(tx,s,{eventIds:rows.map(r=>r.id)})
  await boundary.lockDisputeResources(tx,s,resources)
  return {...resources,branchId}
}
async function assertDisputeEntryReversible(tx,scope,entry,resources){
  if(ownSources.includes(entry.source_type))fail('DISPUTE_ACCOUNTING_PROTECTED','Usa una compensación desde el expediente de disputa',409)
  if(!resources?.eventIds.length)return
  const [row]=await tx.$queryRaw`SELECT EXISTS(SELECT 1 FROM cash_payment_disputes d WHERE d.event_id=ANY(${resources.eventIds}::uuid[]) AND d.company_id=${scope.companyId}::uuid
    AND (d.status<>'CANCELLED' OR EXISTS(SELECT 1 FROM cash_dispute_events e WHERE e.dispute_id=d.id AND e.kind IN('BANK_DEBIT','BANK_RECOVERY','PROVIDER_WITHHOLDING','PROVIDER_RECOVERY','LEGACY_WITHHOLDING','COMPENSATION')))) AS protected`
  if(row.protected)fail('DISPUTE_ACCOUNTING_PROTECTED','El asiento respalda una disputa. Revisa y compensa los documentos vinculados desde su expediente.',409)
}
module.exports={buildDisputeEffectLines,buildDisputeDispositionLines,postDisputeEffect,postDisputeDisposition,postDisputeChain,inspectDisputeAccounting,prepareDisputeEntryReversal,assertDisputeEntryReversible}
