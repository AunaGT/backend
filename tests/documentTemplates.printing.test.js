const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto')
const {harness,ids}=require('./helpers/hardwareHarness.cjs'),{withMocks}=require('./helpers/reportHarness.cjs')
test('V2 artifact is prepared outside the printing transaction and reprints retain its reference',async()=>{
  const h=harness();h.scope.permissions=['sales.create']
  const sale=await h.db.sale.create({data:{branch_id:ids.branch,branch:{company_id:ids.company},created_by:ids.actor}})
  const artifactId=randomUUID(),snapshotId=randomUUID();let active=false,prepared=0
  h.db.documentSnapshot={findFirst:async({select})=>select?.id?null:({id:snapshotId,branding:{cashRegisterId:ids.register}})}
  const transaction=h.db.$transaction;h.db.$transaction=run=>transaction(async tx=>{active=true;try{return await run(tx)}finally{active=false}})
  await withMocks({[require.resolve('../src/modules/sales/documents/artifacts')]:{requestArtifact:async(_db,_scope,input)=>{assert.equal(active,false);assert.equal(input.format,'RECEIPT_80');prepared++;return{id:artifactId,snapshotId,state:'QUEUED'}}}},require.resolve('../src/modules/config/hardware/printing/service'),async printing=>{
    const input={requestKey:randomUUID(),source:{kind:'SALE_TICKET',id:sale.id},document:'MAIN'}
    const first=await printing.createJob(h.db,h.scope,input,{includeDocument:true})
    assert.equal(first.document.renderer,'SALE_DOCUMENT_V2');assert.equal(first.document.artifactId,artifactId)
    const reprint=await printing.reprintJob(h.db,h.scope,first.job.id,{requestKey:randomUUID(),reason:'Reimpresión solicitada',pdfOnly:true})
    const copy=await printing.jobDocument(h.db,h.scope,reprint.id)
    assert.equal(copy.artifactId,artifactId);assert.equal(copy.snapshotId,snapshotId);assert.equal(prepared,1)
  })
})
