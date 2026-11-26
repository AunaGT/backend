const {Prisma}=require('@prisma/client')
const D=v=>new Prisma.Decimal(String(v??0)),zero=()=>D(0)
const fail=()=>{throw Object.assign(new Error('No se puede reconstruir el origen del fondo heredado. Revisa sus documentos de custodia; no se inferirán ingresos.'),{status:409,code:'CASH_DAY_PROVENANCE'})}

// FIFO is an allocation convention, not a new money record. Inputs retain their persisted source IDs.
function cashBridge({date,turns,events,handovers,floatEntries,acceptedDifference='0.00'}){
  const physical=turns.filter(t=>t.register_type==='PHYSICAL'),byTurn=new Map(physical.map(t=>[t.id,t]))
  const lots=new Map(),openings=new Map(),used=new Map(),sent=new Map()
  let floatOut=zero(),floatReceived=zero(),receivedUsed=zero(),receivedOpened=zero()
  const takeRoots=(roots,amount)=>{
    const result=[];let remaining=D(amount)
    for(const root of roots){if(remaining.isZero())break;const used=Prisma.Decimal.min(root.remaining,remaining);if(used.isZero())continue
      result.push({sessionId:root.sessionId,date:root.date,remaining:used});root.remaining=root.remaining.sub(used);remaining=remaining.sub(used)
    }
    if(!remaining.isZero())result.push({sessionId:null,date:null,remaining})
    return result
  }
  for(const entry of floatEntries){
    const queue=lots.get(entry.cash_register_id)||[];lots.set(entry.cash_register_id,queue)
    if(entry.direction==='IN'){
      let roots
      if(entry.leg==='RETAIN')roots=[{sessionId:entry.origin_session_id,date:entry.origin_business_date,remaining:D(entry.amount)}]
      else{
        const source=sent.get(entry.returns_transfer_id||entry.transfer_id)
        roots=source?takeRoots(source.map(r=>({...r})),entry.amount):[{sessionId:entry.transfer_origin_session_id||null,date:entry.transfer_origin_business_date||null,remaining:D(entry.amount)}]
        floatReceived=floatReceived.add(roots.filter(r=>byTurn.has(r.sessionId)).reduce((s,r)=>s.add(r.remaining),zero()))
      }
      queue.push({source:entry,remaining:D(entry.amount),roots});continue
    }
    let remaining=D(entry.amount);const portions=[]
    for(const lot of queue){if(remaining.isZero())break;const amount=Prisma.Decimal.min(remaining,lot.remaining);if(amount.isZero())continue
      const roots=takeRoots(lot.roots,amount),included=roots.filter(r=>byTurn.has(r.sessionId)).reduce((s,r)=>s.add(r.remaining),zero())
      portions.push({source:lot.source,amount,roots,included});lot.remaining=lot.remaining.sub(amount);remaining=remaining.sub(amount)
    }
    if(!remaining.isZero())fail()
    if(entry.leg==='OPENING'){
      openings.set(entry.opening_session_id,portions)
      if(byTurn.has(entry.opening_session_id))for(const p of portions){
        if(p.source.leg==='RETAIN')used.set(p.source.origin_session_id,(used.get(p.source.origin_session_id)||zero()).add(p.amount))
        else{receivedUsed=receivedUsed.add(p.included);receivedOpened=receivedOpened.add(p.included)}
      }
    }else if(entry.leg==='SEND'){
      sent.set(entry.transfer_id,portions.flatMap(p=>p.roots))
      for(const p of portions){
        floatOut=floatOut.add(p.included)
        if(p.source.leg==='RETAIN'&&byTurn.has(p.source.origin_session_id))used.set(p.source.origin_session_id,(used.get(p.source.origin_session_id)||zero()).add(p.amount))
        else if(p.source.leg!=='RETAIN')receivedUsed=receivedUsed.add(p.included)
      }
    }
  }
  let declared=zero(),inherited=zero(),within=zero(),openingTransfers=zero(),openingDifference=zero()
  const sources=[]
  for(const t of physical){
    const expected=D(t.opening_inherited_amount),parts=openings.get(t.id)||[]
    if(!parts.reduce((s,p)=>s.add(p.amount),zero()).eq(expected))fail()
    if(expected.isZero())declared=declared.add(D(t.opening_float))
    else openingDifference=openingDifference.add(D(t.opening_float).sub(expected))
    for(const p of parts){
      const kind=p.source.leg==='RETAIN'?(p.source.origin_business_date===date?'SAME_DAY':'PRIOR_DAY'):'TRANSFER'
      if(kind==='SAME_DAY')within=within.add(p.amount);else if(kind==='PRIOR_DAY')inherited=inherited.add(p.amount);else openingTransfers=openingTransfers.add(p.amount)
      sources.push({sessionId:t.id,entryId:p.source.id,originSessionId:p.source.origin_session_id||null,transferId:p.source.transfer_id||null,kind,amount:p.amount.toFixed(2)})
    }
  }
  const cash=events.filter(e=>e.settlement_kind==='CASH'&&byTurn.has(e.cash_register_session_id))
  const sum=rows=>rows.reduce((s,e)=>s.add(D(e.amount)),zero())
  const externalIn=sum(cash.filter(e=>e.direction==='IN'&&e.source_type!=='CUSTODY_ENTRY')),externalOut=sum(cash.filter(e=>e.direction==='OUT'&&e.source_type!=='CUSTODY_ENTRY'))
  const sessionsIn=sum(cash.filter(e=>e.direction==='IN'&&e.source_type==='CUSTODY_ENTRY')),sessionsOut=sum(cash.filter(e=>e.direction==='OUT'&&e.source_type==='CUSTODY_ENTRY'))
  const relevant=handovers.filter(h=>byTurn.has(h.cash_register_session_id))
  const delivered=relevant.reduce((s,h)=>s.add(D(h.delivered_amount)),zero()),retained=relevant.reduce((s,h)=>s.add(D(h.retained_amount)),zero())
  const consumed=relevant.reduce((s,h)=>s.add(used.get(h.cash_register_session_id)||zero()),zero())
  const retainedFinal=retained.sub(consumed).add(floatReceived).sub(receivedUsed)
  const net=cash.reduce((s,e)=>s.add(e.direction==='IN'?D(e.amount):D(e.amount).neg()),zero())
  const undelivered=physical.reduce((s,t)=>s.add(D(t.opening_float)),zero()).add(net).add(D(acceptedDifference)).sub(delivered).sub(retained)
  const initial=declared.add(inherited),final=retainedFinal.add(undelivered),internalNet=openingTransfers.sub(receivedOpened).add(floatReceived).sub(floatOut).add(sessionsIn).sub(sessionsOut).sub(delivered)
  const calculated=initial.add(externalIn).sub(externalOut).add(internalNet).add(openingDifference).add(D(acceptedDifference)),difference=calculated.sub(final)
  return {initial:initial.toFixed(2),declaredInitial:declared.toFixed(2),inheritedInitial:inherited.toFixed(2),externalIn:externalIn.toFixed(2),externalOut:externalOut.toFixed(2),
    internal:{inheritedWithinDay:within.toFixed(2),openingTransfersIn:openingTransfers.toFixed(2),floatTransfersOut:floatOut.toFixed(2),floatTransfersReceived:floatReceived.toFixed(2),sessionsIn:sessionsIn.toFixed(2),sessionsOut:sessionsOut.toFixed(2),delivered:delivered.toFixed(2),net:internalNet.toFixed(2)},
    openingDifference:openingDifference.toFixed(2),acceptedDifference:D(acceptedDifference).toFixed(2),retainedFinal:retainedFinal.toFixed(2),undeliveredFinal:undelivered.toFixed(2),final:final.toFixed(2),calculatedFinal:calculated.toFixed(2),difference:difference.toFixed(2),balanced:difference.isZero(),sources}
}
module.exports={cashBridge}
