const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process'),assert=require('node:assert/strict')
const root=path.resolve(__dirname,'../..'),migration='20261029120000_event_payment_terms'
function paymentTermsTestUrl(env=process.env){
 let url;try{url=new URL(env.EVENT_PAYMENT_TERMS_TEST_DATABASE_URL)}catch{throw Error('Define EVENT_PAYMENT_TERMS_TEST_DATABASE_URL para una base desechable')}
 if(!['postgresql:','postgres:'].includes(url.protocol)||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||!/^\/auna_payment_terms_test_[a-z0-9_]+$/.test(url.pathname)||url.search||url.hash||url.toString()===env.DATABASE_URL||url.toString()===env.DIRECT_URL)throw Error('Refusing a non-isolated payment terms test database')
 return url.toString()
}
function sql(target,args){
 const out=spawnSync('psql',['-X','--no-password',target,'-v','ON_ERROR_STOP=1',...args],{encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024})
 assert.equal(out.status,0,out.stderr);return out.stdout
}
function paymentTermsClient(target,{legacy=false,namespace=false}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'auna-payment-terms-client-')),output=path.join(dir,'client')
 fs.symlinkSync(path.join(root,'node_modules'),path.join(dir,'node_modules'),'dir')
 let source=fs.readFileSync(path.join(root,'prisma/schema.prisma'),'utf8').replace(/generator client \{[\s\S]*?\}/,`generator client {\n provider = "prisma-client-js"\n output = ${JSON.stringify(output)}\n binaryTargets = ["native"]\n}`)
 if(legacy)source=source.replace(/^\s*event_payment_(?:terms|reference)\s+[^\n]+\n/gm,'\n')
 const schema=path.join(dir,'schema.prisma');fs.writeFileSync(schema,source,{mode:0o600})
 const out=spawnSync(process.execPath,[require.resolve('prisma/build/index.js'),'generate','--schema',schema],{cwd:dir,env:{...process.env,DATABASE_URL:target,DIRECT_URL:target,PRISMA_GENERATE_SKIP_AUTOINSTALL:'true'},encoding:'utf8',timeout:60000})
 assert.equal(out.status,0,out.stderr||out.stdout)
 return namespace?require(output):require(output).PrismaClient
}
function bootstrapPaymentTermsDb(target){
 assert.equal(sql(target,['-Atc',"SELECT count(*) FROM pg_tables WHERE schemaname='public'"]).trim(),'0','Use a fresh empty disposable database')
 sql(target,['-c','CREATE EXTENSION pg_trgm WITH SCHEMA public; CREATE PUBLICATION supabase_realtime;'])
 sql(target,['-c',"DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF; IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF; IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF; END $$;"])
 for(const name of fs.readdirSync(path.join(root,'prisma/migrations'),{withFileTypes:true}).filter(e=>e.isDirectory()&&e.name<migration).map(e=>e.name).sort())sql(target,['-f',path.join(root,'prisma/migrations',name,'migration.sql')])
}
async function fingerprints(db){
 const tables=await db.$queryRaw`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`
 const result={}
 for(const {tablename}of tables){
  const table='"'+tablename.replaceAll('"','""')+'"'
  const filter=tablename==='permissions'?" WHERE code<>'appointments.override_payment_policy'":''
  const [row]=await db.$queryRawUnsafe(`SELECT count(*)::text AS count,md5(COALESCE(string_agg(md5((to_jsonb(t)-'event_payment_terms'-'event_payment_reference')::text),'' ORDER BY md5((to_jsonb(t)-'event_payment_terms'-'event_payment_reference')::text)),'')) AS hash FROM public.${table} t${filter}`)
  result[tablename]=row
 }
 return result
}
module.exports={paymentTermsTestUrl,paymentTermsClient,bootstrapPaymentTermsDb,fingerprints,sql,migration,root}
