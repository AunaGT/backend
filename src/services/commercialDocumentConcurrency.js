async function lockCommercialDocument(tx,{companyId,branchId,type},id){
 const locked=branchId===undefined
  ?await tx.$queryRaw`SELECT d.id FROM public.commercial_documents d JOIN public.branches b ON b.id=d.branch_id WHERE d.id=${id}::uuid AND b.company_id=${companyId}::uuid AND d.doc_type::text=${type} FOR UPDATE OF d`
  :await tx.$queryRaw`SELECT d.id FROM public.commercial_documents d JOIN public.branches b ON b.id=d.branch_id WHERE d.id=${id}::uuid AND b.company_id=${companyId}::uuid AND d.branch_id=${branchId}::uuid AND d.doc_type::text=${type} FOR UPDATE OF d`
 if(!locked.length)return null
 return tx.commercialDocument.findFirst({where:{id,doc_type:type,...(branchId===undefined?{}:{branch_id:branchId}),branch:{company_id:companyId}}})
}
function assertDocumentUnchanged(current,expectedRevision){
 if(!current||typeof expectedRevision!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(expectedRevision)||current.integration_revision!==expectedRevision)throw Object.assign(Error('El documento cambió. Recarga antes de guardar.'),{status:409,code:'DOCUMENT_CHANGED'})
}
module.exports={lockCommercialDocument,assertDocumentUnchanged}
