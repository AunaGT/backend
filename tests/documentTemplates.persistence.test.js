const test=require('node:test')
const assert=require('node:assert/strict')
const {saveDraft,duplicateTemplate,publishTemplate,resolveProfiles,listTemplates}=require('../src/modules/config/documentTemplates/service')
const {resolveBase,freezeProfile}=require('../src/modules/config/documentTemplates/public')
const {randomUUID}=require('node:crypto')
const scope={companyId:'11111111-1111-4111-8111-111111111111',actorId:'22222222-2222-4222-8222-222222222222',permissions:['document_templates.manage','document_templates.publish','document_templates.view']}
const {templateDb}=require('./helpers/documentTemplateHarness.cjs')
const {discardDraft}=require('../src/modules/config/documentTemplates/service')
test('saving drafts never changes the published default; editing a published version opens another draft',async()=>{
  const db=templateDb();const created=await saveDraft(db,scope,{expectedVersion:0,design:resolveBase(),name:'Mi diseño',requestKey:'create-1'})
  assert.equal(db.state.defaults.length,0)
  assert.equal(created.version,1)
  const replay=await saveDraft(db,scope,{expectedVersion:0,design:resolveBase(),name:'Mi diseño',requestKey:'create-1'})
  assert.equal(replay.id,created.id);assert.equal(db.state.templates.length,1)
  await assert.rejects(saveDraft(db,scope,{id:created.id,expectedVersion:0,design:resolveBase(),name:'Cambio',requestKey:'edit-old'}),{status:409})
  const old=await resolveProfiles(db,scope,'INTERNAL_RECEIPT')
  await saveDraft(db,scope,{id:created.id,expectedVersion:1,design:resolveBase('CORPORATE'),name:'Editado',requestKey:'edit-1'})
  assert.deepEqual(await resolveProfiles(db,scope,'INTERNAL_RECEIPT'),old)
})
test('a copied base is independent; reset and duplicate are drafts, not publications',async()=>{
  const db=templateDb();const row=await duplicateTemplate(db,scope,{baseId:'CLASSIC',format:'A4',name:'Copia',requestKey:'dup-1'})
  assert.equal(row.design.paper.format,'A4');assert.equal(db.state.defaults.length,0)
  assert.equal(row.status,'DRAFT')
})
test('publication refuses absent, expired, foreign or stale preflights',async()=>{
  const db=templateDb();const row=await saveDraft(db,scope,{expectedVersion:0,design:resolveBase(),name:'Prueba',requestKey:'create'})
  await assert.rejects(publishTemplate(db,scope,{id:row.id,expectedVersion:row.version,setDefault:true,validationArtifactIds:[],requestKey:'pub'}),{status:409})
  await assert.rejects(publishTemplate(db,{...scope,companyId:'33333333-3333-4333-8333-333333333333'},{id:row.id,expectedVersion:row.version,validationArtifactIds:[],requestKey:'pub-other'}),{status:404})
})
function trustedPreviews(db,row,change=()=>{}) {
  const ids=[]
  for(const scenario of ['SHORT','LONG','LONG_TEXT']) {
    const artifact={id:randomUUID(),company_id:scope.companyId,state:'READY',profile_hash:freezeProfile(row.design).designHash,renderer_version:freezeProfile(row.design).rendererVersion,snapshot:{company_id:scope.companyId,actor_id:scope.actorId,source_kind:'PREVIEW',expires_at:new Date(Date.now()+100000),scenario}}
    change(artifact);db.state.artifacts.push(artifact);ids.push(artifact.id)
  }
  return ids
}
test('a publication with three trusted scenarios changes the default; a later draft leaves it intact',async()=>{
  const db=templateDb();let row=await saveDraft(db,scope,{expectedVersion:0,design:resolveBase(),name:'Prueba',requestKey:'new'})
  row=await publishTemplate(db,scope,{id:row.id,expectedVersion:1,setDefault:true,validationArtifactIds:trustedPreviews(db,row),requestKey:'pub'})
  assert.equal(row.status,'PUBLISHED');assert.equal(db.state.defaults[0].version_id,row.versionId)
  const before=await resolveProfiles(db,scope,'INTERNAL_RECEIPT')
  const draft=await saveDraft(db,scope,{id:row.id,expectedVersion:2,name:'Cambio',design:resolveBase('COMPACT'),requestKey:'edit'})
  assert.equal(draft.status,'DRAFT');assert.notEqual(draft.versionId,row.versionId)
  assert.deepEqual(await resolveProfiles(db,scope,'INTERNAL_RECEIPT'),before)
  assert.equal(db.state.versions.find(v=>v.id===row.versionId).state,'PUBLISHED')
  const listed=await listTemplates(db,scope,{})
  assert.equal(listed.rows[0].isDefault,true);assert.equal(listed.rows[0].activeVersionNumber,1)
})
test('an already published version can become the default after validating current appearance without rewriting the version',async()=>{
  const db=templateDb();let row=await saveDraft(db,scope,{expectedVersion:0,design:resolveBase(),name:'Publicado',requestKey:'new'})
  const ids=trustedPreviews(db,row)
  row=await publishTemplate(db,scope,{id:row.id,expectedVersion:1,setDefault:false,validationArtifactIds:ids,requestKey:'pub'})
  assert.equal(db.state.defaults.length,0)
  const selected=await publishTemplate(db,scope,{id:row.id,expectedVersion:2,setDefault:true,validationArtifactIds:ids,requestKey:'choose-default'})
  assert.equal(selected.versionId,row.versionId);assert.equal(db.state.defaults[0].version_id,row.versionId);assert.equal(db.state.versions.length,1)
})
test('expired, other-author, real-sale and mismatched design previews cannot authorize publication',async()=>{
  for(const change of [a=>a.snapshot.expires_at=new Date(0),a=>a.snapshot.actor_id=randomUUID(),a=>a.snapshot.scenario='REAL_SALE',a=>a.profile_hash='f'.repeat(64),a=>a.company_id=randomUUID()]) {
    const db=templateDb(),row=await saveDraft(db,scope,{expectedVersion:0,design:resolveBase(),name:'Prueba',requestKey:'new'})
    const ids=trustedPreviews(db,row,change)
    await assert.rejects(publishTemplate(db,scope,{id:row.id,expectedVersion:1,setDefault:true,validationArtifactIds:ids,requestKey:'pub'}),e=>[404,409].includes(e.status))
    assert.equal(db.state.defaults.length,0);assert.equal(db.state.versions[0].state,'DRAFT')
  }
})
test('discarding an unpublished template keeps its resources and never removes a published original',async()=>{
  const db=templateDb(),draft=await saveDraft(db,scope,{expectedVersion:0,design:resolveBase(),name:'Descartar',requestKey:'new'})
  db.state.assets.push({id:randomUUID(),company_id:scope.companyId,version_id:draft.versionId})
  const discarded=await discardDraft(db,scope,{id:draft.id,expectedVersion:1,requestKey:'discard'})
  assert.equal(discarded.state,'ARCHIVED');assert.equal(db.state.assets.length,1)
  const published=await saveDraft(db,scope,{expectedVersion:0,design:resolveBase(),name:'Activo',requestKey:'new2'})
  await publishTemplate(db,scope,{id:published.id,expectedVersion:1,validationArtifactIds:trustedPreviews(db,published),requestKey:'pub2'})
  await assert.rejects(discardDraft(db,scope,{id:published.id,expectedVersion:2,requestKey:'discard2'}),{status:409})
})
