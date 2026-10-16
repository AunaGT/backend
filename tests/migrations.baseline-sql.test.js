const test=require('node:test'),assert=require('node:assert/strict')
const {compileBaseline,compileRehearsal,assertQaSchema,statements}=require('../scripts/migrations/baselineSql')
const schema='auna_baseline_qa_'+'a'.repeat(32)
const inventory={tables:[{name:'sales'}],functions:[{name:'guard'}],types:[],sequences:[],extensionObjects:[{schema:'public',name:'gin_trgm_ops',kind:'opclass'}],grants:[],functionGrants:[],publications:[]}
test('shared schemas and malformed temporary identities cannot be rehearsal or cleanup targets',()=>{
  for(const name of ['public','auth','storage','auna_migration_audit','auna_baseline_qa_'])assert.throws(()=>assertQaSchema(name),{code:'BASELINE_SCHEMA_INVALID'})
  assert.equal(assertQaSchema(schema),schema)
})
test('psql connection commands and cross-schema writes are rejected before execution',()=>{
  for(const sql of ['\\connect other','INSERT INTO auth.users VALUES (1);','ALTER PUBLICATION supabase_realtime ADD TABLE public.sales;','SET ROLE postgres;'])
    assert.throws(()=>compileRehearsal(sql,{schema,inventory}),{code:'BASELINE_SQL_UNSUPPORTED'})
})
test('function semicolons remain intact and Auna references and regclass are remapped',()=>{
  const sql="CREATE FUNCTION public.guard() RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN PERFORM 'a;b'; PERFORM 1 FROM public.sales; PERFORM 'public.sales'::regclass; RETURN NEW; END $fn$;"
  assert.equal(statements(sql).length,1)
  const output=compileRehearsal(sql,{schema,inventory})
  assert.match(output,new RegExp('FROM "'+schema+'"\\.sales'))
  assert.match(output,new RegExp("'"+schema+"\\.sales'::regclass"))
  assert.match(output,/'a;b'/)
})
test('extension opclass stays external while the indexed Auna table is isolated',()=>{
  const output=compileRehearsal('CREATE INDEX ix ON public.sales USING gin (customer public.gin_trgm_ops);',{schema,inventory})
  assert.match(output,/public\.gin_trgm_ops/);assert.match(output,new RegExp('ON "'+schema+'"\\.sales'))
})
test('dump random psql delimiters and headers do not change canonical SQL',()=>{
  const dump=t=>`-- dump\n\\restrict ${t}\nSET row_security = off;\nCREATE SCHEMA public;\nCREATE TABLE public.sales ("quoted""column" text);\n\\unrestrict ${t}\n`
  assert.equal(compileBaseline(dump('one'),inventory).sql,compileBaseline(dump('two'),inventory).sql)
  assert.match(compileBaseline(dump('one'),inventory).sql,/"quoted""column"/)
  assert.throws(()=>compileBaseline(dump('one').replace('\\unrestrict one','\\unrestrict wrong'),inventory),{code:'BASELINE_SQL_UNSUPPORTED'})
})
test('dump cannot add business data or dynamic function execution',()=>{
  assert.throws(()=>compileBaseline("INSERT INTO public.sales VALUES (1);",inventory),{code:'BASELINE_SQL_UNSUPPORTED'})
  assert.throws(()=>compileRehearsal("CREATE FUNCTION public.guard() RETURNS void LANGUAGE plpgsql AS $$ BEGIN EXECUTE 'DELETE FROM public.sales'; END $$;",{schema,inventory}),{code:'BASELINE_SQL_UNSUPPORTED'})
})
test('structural dump cannot smuggle bootstrap or payment data and executable bodies need audited dollar quoting',()=>{
  for(const sql of ["INSERT INTO public.sale_statuses(name) VALUES ('Borrador'),('Unexpected');", "UPDATE payment_methods SET name='changed';",'DO $$ BEGIN NULL; END $$;'])
    assert.throws(()=>compileBaseline(sql,inventory),{code:'BASELINE_SQL_UNSUPPORTED'})
  assert.throws(()=>compileRehearsal("CREATE FUNCTION public.guard() RETURNS void LANGUAGE sql AS 'DELETE FROM public.sales';",{schema,inventory}),{code:'BASELINE_SQL_UNSUPPORTED'})
  assert.throws(()=>compileRehearsal('DO $$ BEGIN NULL; END $$;',{schema,inventory}),{code:'BASELINE_SQL_UNSUPPORTED'})
})
test('baseline does not freeze a full-table publication into a column list or inherit sequence grants',()=>{
  const input={...inventory,sequences:[{name:'sales_id_seq'}],publications:[{pubname:'supabase_realtime',table:'sales',attnames:['id','total'],rowfilter:null,explicit_columns:false,all_tables:false}]}
  const result=compileBaseline('CREATE TABLE public.sales(id int);',input)
  assert.match(result.environmentSql,/ADD TABLE ONLY public\."sales";/)
  assert.doesNotMatch(result.environmentSql,/"sales" \(/)
  assert.match(result.environmentSql,/REVOKE ALL ON SEQUENCE public\."sales_id_seq"/)
})
