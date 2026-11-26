const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto')
const {authorizeSaleDocument}=require('../src/modules/sales/documents/snapshot')
const scope={companyId:randomUUID(),branchId:randomUUID(),actorId:randomUUID(),permissions:['sales.create']}
test('cashier can read own sale without settings permissions but a template administrator cannot read it',async()=>{
  const sale={id:randomUUID(),created_by:scope.actorId},db={sale:{findFirst:async()=>sale}}
  assert.equal((await authorizeSaleDocument(db,scope,sale.id)).id,sale.id)
  await assert.rejects(authorizeSaleDocument(db,{...scope,actorId:randomUUID(),permissions:['document_templates.manage']},sale.id),{status:403})
  await assert.rejects(authorizeSaleDocument(db,{...scope,actorId:randomUUID()},sale.id),{status:404})
  await assert.rejects(authorizeSaleDocument(db,{...scope,branchId:null},sale.id),{status:400})
})
test('list-only sale access does not grant original documents, including own documents',async()=>{
  const sale={id:randomUUID(),created_by:scope.actorId},db={sale:{findFirst:async()=>sale}}
  await assert.rejects(authorizeSaleDocument(db,{...scope,permissions:['sales.view']},sale.id),{status:403})
  await assert.rejects(authorizeSaleDocument(db,{...scope,actorId:randomUUID(),permissions:['sales.view_detail']},sale.id),{status:403})
  assert.equal((await authorizeSaleDocument(db,{...scope,actorId:randomUUID(),permissions:['sales.view_invoice']},sale.id)).id,sale.id)
})
