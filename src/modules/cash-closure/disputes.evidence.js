// Archivos privados de un expediente: cash-evidence/<empresa>/disputes/<expediente>/<uuid>.<ext>, firmados 60 s.
const {createHash,randomUUID}=require('node:crypto')
const {fail}=require('./disputes.domain')
const {beginDisputeCommand,finishDisputeCommand,validId}=require('./disputes.boundary')
const {getDispute,requireAvailable}=require('./disputes.queries')
const storage=require('./noticeEvidence')
const UUID='[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}'
const pathFor=(companyId,caseId)=>new RegExp(`^${companyId}/disputes/${caseId}/${UUID}\\.(pdf|png|jpg)$`,'i')
const cleanName=name=>String(name||'evidencia').normalize('NFC').replace(/[\u0000-\u001f\\/]/g,' ').trim().slice(0,120)||'evidencia'

async function attachDisputeEvidence(tx,scope,caseId,{file,requestKey}){
 if(!scope.can?.manage&&!scope.can?.movements)fail('DISPUTE_FORBIDDEN','No tienes permiso para agregar soporte a este expediente',403)
 await requireAvailable(tx)
 if(!file?.buffer)fail('DISPUTE_INPUT_INVALID','Selecciona el archivo de soporte')
 const doc=await getDispute(tx,scope,caseId)
 // El intento se identifica por el contenido: reintentar el mismo archivo no lo carga dos veces.
 const payload={caseId:doc.id,sha256:createHash('sha256').update(file.buffer).digest('hex'),size:file.size??file.buffer.length,name:cleanName(file.originalname)}
 const attempt=await beginDisputeCommand(tx,scope,'ATTACH_EVIDENCE',{requestKey},payload)
 if(attempt.replayed)return attempt.result
 await tx.$queryRaw`SELECT id FROM cash_payment_disputes WHERE id=${doc.id}::uuid FOR UPDATE`
 const stored=await storage.storeEvidence(`${scope.companyId}/disputes/${doc.id}`,file),id=randomUUID()
 await tx.$executeRaw`INSERT INTO cash_dispute_events(id,dispute_id,company_id,branch_id,kind,evidence,payload,accounting_status,actor_id)
   VALUES(${id}::uuid,${doc.id}::uuid,${scope.companyId}::uuid,${scope.branchId}::uuid,'EVIDENCE',${JSON.stringify({path:stored.path,sha256:payload.sha256})}::jsonb,
     ${JSON.stringify({action:'ATTACHED',fileName:payload.name,mimeType:stored.mimeType,fileSize:String(stored.size)})}::jsonb,'ZERO',${scope.userId}::uuid)`
 await tx.$executeRaw`UPDATE cash_payment_disputes SET version=version+1 WHERE id=${doc.id}::uuid`
 return finishDisputeCommand(tx,attempt,await getDispute(tx,scope,doc.id))
}
// Firma solo un archivo que pertenece a este expediente visible para quien consulta.
async function signDisputeEvidence(db,scope,caseId,evidenceId){
 const doc=await getDispute(db,scope,caseId)
 if(!validId(evidenceId))fail('DISPUTE_NOT_FOUND','Soporte no encontrado',404)
 const [row]=await db.$queryRaw`SELECT evidence->>'path' AS path FROM cash_dispute_events WHERE id=${evidenceId.toLowerCase()}::uuid AND dispute_id=${doc.id}::uuid AND kind='EVIDENCE'`
 if(!row?.path||!pathFor(doc.companyId,doc.id).test(row.path))fail('DISPUTE_NOT_FOUND','Soporte no encontrado',404)
 return storage.signStoredEvidence(row.path)
}
module.exports={attachDisputeEvidence,signDisputeEvidence,evidenceAvailable:storage.evidenceAvailable}
