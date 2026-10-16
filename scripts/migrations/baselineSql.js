const {identifier,hash}=require('./inventory')
const unsupported=()=>{throw Object.assign(new Error('SQL outside the audited baseline grammar'),{code:'BASELINE_SQL_UNSUPPORTED'})}
function assertQaSchema(name){if(!/^auna_baseline_qa_[0-9a-f]{32}$/.test(name))throw Object.assign(new Error('Invalid QA schema'),{code:'BASELINE_SCHEMA_INVALID'});return name}
function stripMeta(sql){
  const lines=sql.split('\n'),commands=lines.filter(l=>/^\s*\\/.test(l))
  if(commands.length){
    if(commands.length!==2||!/^\\restrict (\w+)$/.test(commands[0])||commands[1]!==commands[0].replace('\\restrict','\\unrestrict'))unsupported()
  }
  return lines.filter(l=>!/^\s*\\/.test(l)).join('\n')
}
function tokens(sql){
  const out=[];let i=0
  while(i<sql.length){
    const start=i,c=sql[i]
    if(/\s/.test(c)){while(i<sql.length&&/\s/.test(sql[i]))i++;out.push({kind:'space',text:sql.slice(start,i)});continue}
    if(sql.startsWith('--',i)){i=sql.indexOf('\n',i);if(i<0)i=sql.length;out.push({kind:'comment',text:'\n'});continue}
    if(sql.startsWith('/*',i)){
      let depth=1;i+=2
      while(i<sql.length&&depth){if(sql.startsWith('/*',i)){depth++;i+=2}else if(sql.startsWith('*/',i)){depth--;i+=2}else i++}
      if(depth)unsupported();out.push({kind:'comment',text:'\n'});continue
    }
    if(c==='"'||c==="'"){
      i++;let closed=false
      while(i<sql.length){if(sql[i]===c){if(sql[i+1]===c){i+=2;continue}i++;closed=true;break}if(sql[i]==='\\'&&c==="'"&&/[eE]/.test(sql[start-1]||'')){i+=2}else i++}
      if(!closed)unsupported()
      const text=sql.slice(start,i);out.push({kind:c==='"'?'id':'string',text,value:text.slice(1,-1).replaceAll(c+c,c)});continue
    }
    const tag=c==='$'?sql.slice(i).match(/^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/)?.[0]:null
    if(tag){const end=sql.indexOf(tag,i+tag.length);if(end<0)unsupported();i=end+tag.length;out.push({kind:'body',tag,text:sql.slice(start,i),value:sql.slice(start+tag.length,end)});continue}
    if(/[A-Za-z_0-9]/.test(c)){while(i<sql.length&&/[A-Za-z_0-9$]/.test(sql[i]))i++;const text=sql.slice(start,i);out.push({kind:'word',text,value:text});continue}
    i++;out.push({kind:'symbol',text:c})
  }
  return out
}
const significant=ts=>ts.filter(t=>!['space','comment'].includes(t.kind))
function statements(sql){
  const result=[];let current=''
  for(const t of tokens(stripMeta(sql))){current+=t.text;if(t.text===';'&&t.kind==='symbol'){if(current.trim())result.push(current.trim());current=''}}
  if(current.trim())result.push(current.trim())
  return result
}
const value=t=>t?.value??t?.text
const setting=/^SET\s+(?:LOCAL\s+)?(?:statement_timeout|lock_timeout|idle_in_transaction_session_timeout|transaction_timeout|client_encoding|standard_conforming_strings|check_function_bodies|xmloption|client_min_messages|row_security|default_tablespace|default_table_access_method|search_path)\b/i
function ownedNames(inventory){return new Set([...(inventory.tables||[]).map(o=>o.name),...(inventory.types||[]).map(o=>o.name),...(inventory.sequences||[]).map(o=>o.name),...(inventory.functions||[]).map(o=>o.name),'company_payment_methods','PaymentMethodSettlementKind','guard_company_payment_method_owner'])}
function remap(sql,schema,inventory,{body=false}={}){
  const ts=tokens(sql),sig=significant(ts),owned=ownedNames(inventory)
  if(body&&sig.some(t=>t.kind==='word'&&t.text.toUpperCase()==='EXECUTE'))unsupported()
  for(let k=0;k<sig.length;k++){
    const t=sig[k],next=sig[k+1]
    if(t.kind==='body'){t.text=t.tag+remap(t.value,schema,inventory,{body:true})+t.tag;continue}
    if(t.kind==='string'&&t.value.startsWith('public.')&&sig[k+1]?.text===':'&&sig[k+2]?.text===':'){
      if(!['regclass','regtype'].includes(value(sig[k+3])))unsupported()
      const name=t.value.slice(7).replace(/^"|"$/g,'')
      if(!owned.has(name))unsupported()
      t.text="'"+schema+'.'+t.value.slice(7).replaceAll("'","''")+"'";continue
    }
    if(!['word','id'].includes(t.kind)||next?.text!=='.')continue
    const prefix=value(t),name=value(sig[k+2])
    if(prefix==='public'){
      if((inventory.extensionObjects||[]).some(o=>o.schema==='public'&&o.name===name))continue
      if(!owned.has(name))unsupported()
      t.text=identifier(schema)
    }else if(['auth','storage','auna_migration_audit'].includes(prefix))unsupported()
    else if(['FROM','JOIN','INTO','UPDATE','REFERENCES','TABLE','SEQUENCE','FUNCTION','TYPE','ONLY'].includes(String(value(sig[k-1])).toUpperCase())&&![schema,'pg_catalog','extensions'].includes(prefix))unsupported()
  }
  return ts.map(t=>t.text).join('')
}
function checkStatement(sql){
  const sig=significant(tokens(sql)),head=sig.slice(0,7).map(t=>t.text).join(' ')
  if(/^CREATE (?:OR REPLACE )?FUNCTION\b/i.test(head)&&!sig.some(t=>t.kind==='body'))unsupported()
  if(/^CREATE (?:OR REPLACE )?(?:TABLE|TYPE|SEQUENCE|FUNCTION|TRIGGER|POLICY|(?:UNIQUE )?INDEX)\b/i.test(head))return
  if(/^ALTER (?:TABLE|SEQUENCE)\b/i.test(head))return
  if(/^COMMENT ON (?:TABLE|COLUMN|CONSTRAINT|FUNCTION|TYPE|SEQUENCE|INDEX|TRIGGER|POLICY)\b/i.test(head))return
  if(/^(?:BEGIN|COMMIT)\s*;/i.test(head)||/^DO\b/.test(head))return
  if(/^INSERT INTO (?:(?:"public"|public) \. )?"?sale_statuses"?\b/i.test(head)&&sql.includes("'Borrador'"))return
  // Payment migration is hash-bound to its original reviewed artifact by the caller.
  if(/^(?:UPDATE|INSERT INTO) payment_methods\b/i.test(head)||/^INSERT INTO company_payment_methods\b/i.test(head)||/^DROP INDEX payment_methods_name_key\b/i.test(head))return
  unsupported()
}
function renderEnvironment(inventory){
  const allowed=new Set(['PUBLIC','anon','authenticated','service_role','postgres'])
  const result=[]
  for(const t of inventory.tables||[])result.push(`REVOKE ALL ON TABLE public.${identifier(t.name)} FROM PUBLIC, anon, authenticated, service_role;`)
  for(const s of inventory.sequences||[])result.push(`REVOKE ALL ON SEQUENCE public.${identifier(s.name)} FROM PUBLIC, anon, authenticated, service_role;`)
  for(const g of inventory.grants||[]){
    if(!allowed.has(g.grantee))unsupported()
    if(g.grantee==='postgres')continue
    result.push(`GRANT ${g.privilege_type} ON ${g.kind==='S'?'SEQUENCE':'TABLE'} public.${identifier(g.name)} TO ${g.grantee==='PUBLIC'?'PUBLIC':identifier(g.grantee)}${g.is_grantable?' WITH GRANT OPTION':''};`)
  }
  for(const f of inventory.functions||[])result.push(`REVOKE ALL ON FUNCTION public.${identifier(f.name)}(${f.args}) FROM PUBLIC, anon, authenticated, service_role;`)
  for(const g of inventory.functionGrants||[]){
    if(!allowed.has(g.grantee))unsupported();if(g.grantee==='postgres')continue
    result.push(`GRANT ${g.privilege_type} ON FUNCTION public.${identifier(g.name)}(${g.args}) TO ${g.grantee==='PUBLIC'?'PUBLIC':identifier(g.grantee)}${g.is_grantable?' WITH GRANT OPTION':''};`)
  }
  for(const p of inventory.publications||[]){
    if(p.pubname!=='supabase_realtime'||p.rowfilter||p.all_tables||typeof p.explicit_columns!=='boolean')unsupported()
    result.push(`ALTER PUBLICATION ${identifier(p.pubname)} ADD TABLE ONLY public.${identifier(p.table)}${p.explicit_columns?' ('+p.attnames.map(identifier).join(',')+')':''};`)
  }
  return result.join('\n')
}
function compileBaseline(dumpSql,inventory){
  const content=[]
  for(const stmt of statements(dumpSql)){
    if(setting.test(stmt)||/^SELECT pg_catalog\.set_config\('search_path', '', false\);$/.test(stmt))continue
    if(/^CREATE SCHEMA (?:public|"public");$/.test(stmt)||/^COMMENT ON SCHEMA (?:public|"public")\b/.test(stmt))continue
    if(/^(?:INSERT|UPDATE|DELETE|DO)\b/i.test(stmt))unsupported()
    checkStatement(stmt)
    // Validate qualifiers and bodies using a QA destination, without retaining that variant.
    remap(stmt,'auna_baseline_qa_'+'0'.repeat(32),inventory)
    content.push(stmt)
  }
  if((inventory.tables||[]).some(t=>t.name==='sale_statuses'))content.push('INSERT INTO public.sale_statuses(name) VALUES (\'Borrador\') ON CONFLICT(name) DO NOTHING;')
  const environmentSql=renderEnvironment(inventory)
  const sql='BEGIN;\nCREATE SCHEMA IF NOT EXISTS public;\nSET LOCAL search_path=public,pg_catalog,extensions;\n'+content.join('\n')+'\n-- AUNA ENVIRONMENT BEGIN\n'+environmentSql+'\n-- AUNA ENVIRONMENT END\nCOMMIT;\n'
  return {sql,environmentSql,objects:inventory,checksum:hash(sql)}
}
function compileRehearsal(sql,{schema,inventory,artifactChecksum}){
  assertQaSchema(schema)
  if(artifactChecksum&&hash(sql)!==artifactChecksum)throw Error('SQL artifact checksum mismatch')
  if(sql.includes('-- AUNA ENVIRONMENT BEGIN')){
    if(!artifactChecksum)unsupported()
    const parts=sql.split('-- AUNA ENVIRONMENT BEGIN')
    if(parts.length!==2||parts[1].split('-- AUNA ENVIRONMENT END').length!==2)unsupported()
    sql=parts[0]+parts[1].split('-- AUNA ENVIRONMENT END')[1]
  }
  const output=[]
  for(const stmt of statements(sql)){
    if(setting.test(stmt))continue
    if(/^(?:INSERT|UPDATE|DELETE|DO|DROP)\b/i.test(stmt)&&!artifactChecksum)unsupported()
    if(/^CREATE SCHEMA IF NOT EXISTS public;$/.test(stmt)){output.push(`CREATE SCHEMA IF NOT EXISTS ${identifier(schema)};`);continue}
    checkStatement(stmt);output.push(remap(stmt,schema,inventory))
  }
  return `SET search_path=${identifier(schema)},pg_catalog,extensions;\n`+output.join('\n')+'\n'
}
module.exports={assertQaSchema,statements,compileBaseline,compileRehearsal,tokens}
