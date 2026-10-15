const test=require('node:test'),assert=require('node:assert/strict')
let migrationPlan
try { ({migrationPlan}=require('../scripts/sales-drafts-deploy')) }catch(e){if(e.code!=='MODULE_NOT_FOUND')throw e}
test('deploy refuses changed history, failed migrations and unrelated pending migrations',()=>{
  assert.equal(typeof migrationPlan,'function')
  const own='202610140001_sales_drafts_and_external_invoices'
  assert.deepEqual(migrationPlan([{name:'old',checksum:'a'},{name:own,checksum:'b'}],[{migration_name:'old',checksum:'a',finished_at:new Date(),rolled_back_at:null}]),[own])
  assert.throws(()=>migrationPlan([{name:'old',checksum:'b'}],[{migration_name:'old',checksum:'a',finished_at:new Date(),rolled_back_at:null}]),/checksum/i)
  assert.throws(()=>migrationPlan([{name:'unexpected',checksum:'b'}],[]),/unexpected/i)
  assert.throws(()=>migrationPlan([{name:'old',checksum:'a'}],[{migration_name:'old',checksum:'a',finished_at:null,rolled_back_at:null}]),/failed/i)
})
test('archived applied migrations are not replayed or rewritten',()=>{
  assert.deepEqual(migrationPlan([],[{migration_name:'archived',checksum:'historical',finished_at:new Date(),rolled_back_at:null}]),[])
})
test('empty migration directories block preflight before invoking Prisma',()=>{
  assert.throws(()=>migrationPlan([{name:'empty',checksum:null}],[]),/missing migration file/i)
})
test('deployment diagnostics hide URLs and known connection passwords',()=>{
  const {sanitizeDiagnostic}=require('../scripts/sales-drafts-deploy')
  assert.equal(typeof sanitizeDiagnostic,'function')
  assert.equal(sanitizeDiagnostic('Error P3015 postgresql://u:secret@host/db secret',{DIRECT_URL:'postgresql://u:secret@host/db'}),'Error P3015 [connection] [redacted]')
})
