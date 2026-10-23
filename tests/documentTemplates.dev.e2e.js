// Explicit opt-in. Uses existing development company and rolls back every fixture.
const assert=require('node:assert/strict'),{randomUUID}=require('node:crypto')
async function main(args){
  assert.deepEqual(args,['--rollback']);require('../src/config/loadEnv')
  const {PrismaClient}=require('@prisma/client'),{resolveBase,compileTemplate}=require('../src/modules/config/documentTemplates/public')
  const db=new PrismaClient({datasources:{db:{url:process.env.DIRECT_URL}},log:[]})
  const sentinel=Object.assign(new Error('Intentional rollback'),{code:'DOCUMENT_TEST_ROLLBACK'})
  let templateId
  try {
    await assert.rejects(db.$transaction(async tx=>{
      const company=await tx.company.findFirst({where:{active:true},select:{id:true}}),user=await tx.user.findFirst({select:{id:true}})
      assert(company&&user,'Existing development company/user required')
      const design=resolveBase(),compiled=compileTemplate({design})
      const template=await tx.documentTemplate.create({data:{company_id:company.id,name:'Rollback template constraint check',purpose:'INTERNAL_RECEIPT',format:'LETTER',base_id:'CLASSIC',created_by:user.id}});templateId=template.id
      const version=await tx.documentTemplateVersion.create({data:{company_id:company.id,template_id:template.id,number:1,state:'PUBLISHED',published_at:new Date(),created_by:user.id,design,source:compiled.source,design_hash:'a'.repeat(64)}})
      await tx.documentTemplateDefault.create({data:{company_id:company.id,purpose:'INTERNAL_RECEIPT',format:'LETTER',version_id:version.id}})
      async function rejected(fn){await tx.$executeRawUnsafe('SAVEPOINT doc_check');let blocked=false;try{await fn()}catch{blocked=true}await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT doc_check');assert(blocked,'Database constraint did not reject the mutation')}
      await rejected(()=>tx.documentTemplateVersion.update({where:{id:version.id},data:{source:'changed'}}))
      await rejected(()=>tx.documentTemplateVersion.delete({where:{id:version.id}}))
      await rejected(()=>tx.documentTemplateVersion.create({data:{company_id:randomUUID(),template_id:template.id,number:2,created_by:user.id,design,source:compiled.source,design_hash:'b'.repeat(64)}}))
      await rejected(()=>tx.documentTemplateDefault.update({where:{company_id_purpose_format:{company_id:company.id,purpose:'INTERNAL_RECEIPT',format:'LETTER'}},data:{format:'A4'}}))
      throw sentinel
    },{maxWait:10000,timeout:30000}),e=>e.code===sentinel.code)
    assert.equal(await db.documentTemplate.count({where:{id:templateId}}),0)
    console.log(JSON.stringify({rollback:true,publishedImmutable:true,foreignKeyIsolation:true,defaultFormatValidated:true}))
  }finally{await db.$disconnect()}
}
if(require.main===module)main(process.argv.slice(2)).catch(e=>{console.error(JSON.stringify({status:'error',code:e.code||'DOCUMENT_TEST_FAILED',name:e.name}));process.exitCode=1})
module.exports={main}
