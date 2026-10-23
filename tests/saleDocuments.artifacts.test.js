const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto')
const {requestPreparedArtifact}=require('../src/modules/sales/documents/artifacts')
const {templateDb}=require('./helpers/documentTemplateHarness.cjs')
const {resolveBase,freezeProfile}=require('../src/modules/config/documentTemplates/public')
test('two formats share one snapshot and repeated requests reuse the same artifact without eager renders',async()=>{
  const db=templateDb(),scope={companyId:randomUUID(),actorId:randomUUID()},snapshot={id:randomUUID(),company_id:scope.companyId,profiles:Object.fromEntries(['A4','RECEIPT_80','LETTER'].map(f=>[f,freezeProfile(resolveBase('CLASSIC',f))]))}
  const ticket=await requestPreparedArtifact(db,scope,snapshot,'RECEIPT_80'),sheet=await requestPreparedArtifact(db,scope,snapshot,'A4')
  assert.equal(sheet.snapshotId,ticket.snapshotId);assert.equal(db.state.artifacts.length,2)
  const second=await requestPreparedArtifact(db,scope,snapshot,'RECEIPT_80');assert.equal(second.id,ticket.id)
  assert.equal(second.state,'QUEUED');assert.equal('path' in second,false)
})
