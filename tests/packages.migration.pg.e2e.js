// Opt-in only: an empty, loopback-only, explicitly named disposable database.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os')
const {spawnSync}=require('node:child_process'),{randomUUID}=require('node:crypto')
const target=process.env.PACKAGES_TEST_DATABASE_URL
let endpoint
try{endpoint=new URL(target)}catch{throw Error('PACKAGES_TEST_DATABASE_URL must name an isolated test database')}
if(!['postgres:','postgresql:'].includes(endpoint.protocol)||!['127.0.0.1','localhost','[::1]'].includes(endpoint.hostname)||!/^\/auna_packages_test_[a-z0-9_]+$/.test(endpoint.pathname)||endpoint.search||endpoint.hash||target===process.env.DATABASE_URL||target===process.env.DIRECT_URL)throw Error('Refusing a non-isolated package test database')
const root=path.resolve(__dirname,'..'),migrationName='20261026120000_commercial_packages'
function psql(args){const result=spawnSync('psql',['-X','--no-password',target,'-v','ON_ERROR_STOP=1',...args],{encoding:'utf8',timeout:60000});assert.equal(result.status,0,result.stderr);return result.stdout}
function generatedClient({beforeMigration=false}={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'auna-packages-client-')),output=path.join(dir,'client')
  fs.symlinkSync(path.join(root,'node_modules'),path.join(dir,'node_modules'),'dir')
  // Mechanical generation of a test-only schema never changes the app client.
  let source=fs.readFileSync(path.join(root,'prisma/schema.prisma'),'utf8').replace(/generator client \{[\s\S]*?\}/,`generator client {\n provider = "prisma-client-js"\n output = ${JSON.stringify(output)}\n binaryTargets = ["native"]\n}`)
  if(beforeMigration)source=source.replace(/^\s*package_(?:groups|component_key)\s+[^\n]+\n/gm,'\n')
  const schema=path.join(dir,'schema.prisma');fs.writeFileSync(schema,source,{mode:0o600})
  const result=spawnSync(process.execPath,[require.resolve('prisma/build/index.js'),'generate','--schema',schema],
    {cwd:dir,env:{...process.env,DATABASE_URL:target,DIRECT_URL:target,PRISMA_GENERATE_SKIP_AUTOINSTALL:'true'},encoding:'utf8',timeout:60000})
  assert.equal(result.status,0,result.stderr||result.stdout)
  return require(output).PrismaClient
}
test('additive packages migration preserves existing documents, credentials and receipts',async t=>{
  assert.equal(psql(['-Atc',"SELECT count(*) FROM pg_tables WHERE schemaname='public'"]).trim(),'0','Use a fresh disposable database, never an existing application database')
  psql(['-c','CREATE EXTENSION pg_trgm WITH SCHEMA public; CREATE PUBLICATION supabase_realtime;'])
  psql(['-c',"DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF; IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF; IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF; END $$;"])
  const migrations=fs.readdirSync(path.join(root,'prisma/migrations'),{withFileTypes:true}).filter(entry=>entry.isDirectory()&&entry.name<migrationName).map(entry=>entry.name).sort()
  for(const name of migrations)psql(['-f',path.join(root,'prisma/migrations',name,'migration.sql')])
  const OldClient=generatedClient({beforeMigration:true}),beforeDb=new OldClient({datasources:{db:{url:target}}})
  t.after(()=>beforeDb.$disconnect())
  const company=await beforeDb.company.create({data:{name:'Synthetic package migration',code:randomUUID().slice(0,12)}})
  const role=await beforeDb.role.create({data:{name:'admin',system_key:'ADMIN'}})
  const actor=await beforeDb.user.create({data:{name:'Synthetic package owner',email:randomUUID()+'@invalid.test',password:'synthetic-only',role_id:role.id}})
  await beforeDb.userCompany.create({data:{company_id:company.id,user_id:actor.id,role_id:role.id}})
  const branch=await beforeDb.branch.create({data:{company_id:company.id,name:'Synthetic branch',code:'QA'}})
  await beforeDb.userBranch.create({data:{user_id:actor.id,branch_id:branch.id}})
  const customer=await beforeDb.supplier.create({data:{company_id:company.id,party_type:'CUSTOMER',name:'Synthetic customer',contact:'Synthetic',tax_id:'123-K'}})
  const category=await beforeDb.productCategory.create({data:{company_id:company.id,name:'Synthetic'}}),status=await beforeDb.stockStatus.create({data:{name:'Synthetic '+randomUUID()}})
  const product=await beforeDb.product.create({data:{company_id:company.id,name:'Synthetic shot',category_id:category.id,status_id:status.id,price:'10',cost:'0',unit_metadata_version:1}})
  const scope={companyId:company.id,actorId:actor.id,branchId:branch.id,branchIds:[branch.id],isAdmin:true,permissions:[]}
  const issued=await require('../src/modules/integrations/management').createCredential(beforeDb,scope,{name:'Synthetic package fixture',ownerId:actor.id,scopes:['quotes.read','quotes.create_draft'],branchIds:[branch.id],days:90})
  const context=await require('../src/modules/integrations/auth').authenticateIntegration(beforeDb,'Bearer '+issued.apiKey)
  const draft=await require('../src/modules/integrations/drafts').createIntegrationDraft(beforeDb,context,'QUOTE',{branchId:branch.id,customerId:customer.id,items:[{productId:product.id,quantity:'1'}]},'synthetic-package-draft-1234')
  const snapshot={credential:await beforeDb.integrationCredential.findUnique({where:{id:issued.credential.id}}),operation:await beforeDb.integrationDraftOperation.findFirst({where:{document_id:draft.receipt.id}}),document:await beforeDb.commercialDocument.findFirst({where:{id:draft.receipt.id}})}
  psql(['-f',path.join(root,'prisma/migrations',migrationName,'migration.sql')])
  assert.deepEqual(await beforeDb.integrationCredential.findUnique({where:{id:issued.credential.id}}),snapshot.credential)
  assert.deepEqual(await beforeDb.integrationDraftOperation.findFirst({where:{document_id:draft.receipt.id}}),snapshot.operation)
  assert.deepEqual(await beforeDb.commercialDocument.findFirst({where:{id:draft.receipt.id}}),snapshot.document)
  const Client=generatedClient(),db=new Client({datasources:{db:{url:target}}});t.after(()=>db.$disconnect())
  assert.equal((await db.commercialDocument.findFirst({where:{id:draft.receipt.id}})).package_groups,null)
  const security=await db.$queryRaw`SELECT relname,relrowsecurity,(SELECT count(*)::int FROM pg_policy WHERE polrelid=c.oid) AS policies FROM pg_class c WHERE relname IN ('commercial_packages','commercial_package_versions','commercial_package_branches','commercial_package_commands') ORDER BY relname`
  assert.equal(security.length,4);assert.ok(security.every(row=>row.relrowsecurity&&row.policies===0))
  const definition={schemaVersion:1,name:'Synthetic package',description:'',imageUrl:null,currency:'GTQ',variants:[{id:randomUUID(),name:'Two products',price:'15.00',components:[{id:randomUUID(),productId:product.id,quantity:'2',presentationId:null,unitRevision:product.unit_revision,weight:'1'}],choices:[]}]}
  const catalog=require('../src/modules/inventory/packages/catalog'),created=await catalog.savePackage(db,scope,null,{expectedVersion:0,definition,branchIds:[branch.id],idempotencyKey:randomUUID()})
  await assert.rejects(db.commercialPackage.update({where:{id:created.id},data:{draft_definition:{}}}))
  const active=await catalog.activatePackageVersion(db,scope,created.id,{expectedVersion:created.version,idempotencyKey:randomUUID()})
  assert.equal(active.activeVersion,1)
  const agreement=require('../src/services/commercialPackages')
  const selection={groupId:randomUUID(),packageId:created.id,version:1,variantId:definition.variants[0].id,choices:[]}
  const built=await db.$transaction(tx=>agreement.buildPackageGroups(tx,scope,[selection],{allowIncomplete:true}))
  const packageQuote=await db.commercialDocument.create({data:{branch_id:branch.id,doc_type:'QUOTE',status:'DRAFT',subtotal:built.subtotal,discount_total:'0',total:built.subtotal,
    package_groups:built.groups,lines:{create:built.lines.map((l,i)=>({...l,sort_order:i,service_schedule_snapshot:require('@prisma/client').Prisma.DbNull}))}},include:{lines:true}})
  agreement.assertPackageAgreement(packageQuote,{requireComplete:true})
  assert.equal(packageQuote.lines.length,1);assert.equal(packageQuote.lines[0].line_total.toFixed(2),'15.00')
  const reopened=await db.$transaction(tx=>agreement.buildPackageGroups(tx,scope,[selection],{existingGroups:packageQuote.package_groups,allowIncomplete:true}))
  assert.deepEqual(reopened.groups,packageQuote.package_groups)
  const published=await db.commercialPackageVersion.findFirst({where:{package_id:created.id}})
  await assert.rejects(db.commercialPackageVersion.update({where:{id:published.id},data:{definition:{...definition,name:'tampered'}}}))
  await assert.rejects(db.commercialPackageVersion.delete({where:{id:published.id}}))
  const foreign=await db.company.create({data:{name:'Synthetic foreign company',code:randomUUID().slice(0,12)}}),foreignBranch=await db.branch.create({data:{company_id:foreign.id,name:'Other',code:'OTH'}})
  await assert.rejects(db.commercialPackageBranch.create({data:{company_id:company.id,package_id:created.id,branch_id:foreignBranch.id}}))
  const revision=(await db.commercialDocument.findUnique({where:{id:draft.receipt.id}})).integration_revision
  await db.commercialDocument.update({where:{id:draft.receipt.id},data:{package_groups:[]}})
  assert.notEqual((await db.commercialDocument.findUnique({where:{id:draft.receipt.id}})).integration_revision,revision)
  const line=await db.commercialDocumentLine.findFirst({where:{document_id:draft.receipt.id}}),beforeKey=(await db.commercialDocument.findUnique({where:{id:draft.receipt.id}})).integration_revision
  await db.commercialDocumentLine.update({where:{id:line.id},data:{package_component_key:`${randomUUID()}:${randomUUID()}`}})
  assert.notEqual((await db.commercialDocument.findUnique({where:{id:draft.receipt.id}})).integration_revision,beforeKey)
  const beforeRollback=await db.commercialPackage.findUnique({where:{id:created.id}})
  await assert.rejects(db.$transaction(async tx=>{await tx.commercialPackage.update({where:{id:created.id},data:{name:'rolled back'}});throw Error('synthetic rollback')}))
  assert.deepEqual(await db.commercialPackage.findUnique({where:{id:created.id}}),beforeRollback)
  assert.equal((await db.$queryRaw`SELECT count(*)::int AS n FROM pg_trigger WHERE tgrelid='public.stock_reservations'::regclass AND tgname='document_revision_reservations'`)[0].n,1)
  t.diagnostic('Original credentials, receipts and documents preserved; new client generated only in a disposable directory')
})
