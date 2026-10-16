const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path')
const {hash}=require('../scripts/migrations/inventory')
const {createMigrationResolver}=require('../scripts/migrationFiles')
test('migration resolver distinguishes active and explicit historical files, detects tampering and traversal',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'auna-migration-files-'))
  t.after(()=>fs.rmSync(root,{recursive:true}))
  const active=path.join(root,'prisma/migrations'),archive=path.join(root,'prisma/migrations-archive/pre-baseline-20261015')
  for(const [base,name] of [[active,'new'],[archive,'old']]){fs.mkdirSync(path.join(base,name),{recursive:true});fs.writeFileSync(path.join(base,name,'migration.sql'),'SELECT 1;')}
  fs.writeFileSync(path.join(archive,'manifest.json'),JSON.stringify({migrations:[{name:'old',checksum:hash('SELECT 1;')}]}))
  const r=createMigrationResolver(root)
  assert.equal(r.migrationSqlPath('new'),path.join(active,'new/migration.sql'))
  assert.throws(()=>r.migrationSqlPath('old'),{code:'MIGRATION_ARCHIVED'})
  assert.equal(r.migrationSqlPath('old',{historical:true}),path.join(archive,'old/migration.sql'))
  assert.throws(()=>r.migrationSqlPath('../old'),{code:'MIGRATION_NAME_INVALID'})
  fs.writeFileSync(path.join(archive,'old/migration.sql'),'SELECT 2;')
  assert.throws(()=>r.migrationSqlPath('old',{historical:true}),{code:'MIGRATION_CHECKSUM_MISMATCH'})
  fs.mkdirSync(path.join(active,'old'));fs.writeFileSync(path.join(active,'old/migration.sql'),'SELECT 1;')
  assert.throws(()=>r.migrationSqlPath('old',{historical:true}),{code:'MIGRATION_DUPLICATED'})
})
test('retired deployment CLIs fail with an archive diagnostic before connecting',()=>{
  const {spawnSync}=require('node:child_process')
  for(const script of ['apply-hr-documents-migration.js','apply-returns-migration.js','appointments-staging.js','coupon-staging.js','sales-drafts-deploy.js']){
    const result=spawnSync(process.execPath,[path.join(__dirname,'../scripts',script),'--apply'],{env:{...process.env,DIRECT_URL:'postgresql://nobody:nothing@127.0.0.1:1/absent'},encoding:'utf8',timeout:5000})
    assert.equal(result.status,1,script);assert.match(result.stderr,/MIGRATION_ARCHIVED/,script)
  }
})
