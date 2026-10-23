const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),express=require('express')
const {createRouter}=require('../src/modules/config/documentTemplates/routes')
const {templateDb}=require('./helpers/documentTemplateHarness.cjs')
const {resolveBase}=require('../src/modules/config/documentTemplates/public')
test('authenticated template API separates save and publish and keeps errors private',async()=>{
  const db=templateDb(),app=express()
  const scope={companyId:'11111111-1111-4111-8111-111111111111',actorId:'22222222-2222-4222-8222-222222222222',permissions:['document_templates.manage']}
  app.use(createRouter({db,transactionDb:db,auth:(_req,_res,next)=>next(),scope:()=>scope}))
  const server=http.createServer(app);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  const endpoint=`http://127.0.0.1:${server.address().port}`
  try {
    const call=(url,body)=>fetch(endpoint+url,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{})
    const schema=await call('/schema');assert.equal(schema.status,200);assert.match(schema.headers.get('cache-control'),/no-store/)
    const manifest=await schema.json();assert.equal(manifest.schemaVersion,1)
    assert.equal(manifest.defaults.ticketFormat,'RECEIPT_80');assert.equal(manifest.fiscalEnabled,false)
    assert.equal(manifest.fiscalPresets.CLASSIC.LETTER.purpose,'FEL_INVOICE')
    db.state.settings.push({company_id:scope.companyId,key:'fel_enabled',value:'true'})
    assert.equal((await (await call('/schema')).json()).fiscalEnabled,true)
    const saved=await call('/',{expectedVersion:0,design:resolveBase(),name:'Nuevo',requestKey:'save-api'})
    assert.equal(saved.status,201);const row=await saved.json();assert.equal(row.status,'DRAFT')
    const denied=await call(`/${row.id}/publish`,{expectedVersion:row.version,requestKey:'publish-api'})
    assert.equal(denied.status,403);assert.equal(db.state.defaults.length,0)
    const bad=await call('/compile',{source:'<!DOCTYPE x><x/>'});assert.equal(bad.status,400);assert.equal((await bad.json()).diagnostics[0].line,1)
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
})
