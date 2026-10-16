const {createHash}=require('node:crypto')
const identifier=value=>'"'+String(value).replaceAll('"','""')+'"'
function canonical(value){
  if(Array.isArray(value))return value.map(canonical)
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])]))
  return value
}
const hash=value=>createHash('sha256').update(value).digest('hex')
const fingerprintRows=rows=>hash(rows.map(r=>typeof r==='string'?r:JSON.stringify(canonical(r))).sort().join('\n'))
function normalizedDefinition(sql){
  return sql.replace(/\(ARRAY\[([^\]]*)\]\)::text\[\]|ARRAY\[([^\]]*)\](::text\[\])?/g,(whole,wrapped,plain,cast)=>{
    const elements=(wrapped??plain).match(/\(?\s*'(?:[^']|'')*'::character varying\)?(?:::text)?/g)
    if(!elements||elements.join(', ').replaceAll(' ','')!==(wrapped??plain).replaceAll(' ',''))return whole
    if(!wrapped&&!cast&&!elements.every(v=>v.endsWith('::text')))return whole
    return 'ARRAY['+elements.map(v=>v.match(/'(?:[^']|'')*'/)[0]+'::text').join(', ')+']'
  })
}
const queries={
  tables:`SELECT c.relname AS name,c.relkind::text AS kind,c.relrowsecurity AS rls,c.relforcerowsecurity AS force_rls FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind IN ('r','p') AND c.relname<>'_prisma_migrations' AND NOT EXISTS(SELECT 1 FROM pg_depend d WHERE d.objid=c.oid AND d.deptype='e') ORDER BY c.relname`,
  columns:`SELECT c.relname AS table,a.attname AS name,a.attnum::int AS position,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull AS not_null,a.attidentity::text AS identity,a.attgenerated::text AS generated,pg_get_expr(d.adbin,d.adrelid) AS expression FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum WHERE n.nspname=$1 AND c.relkind IN ('r','p') AND c.relname<>'_prisma_migrations' AND a.attnum>0 AND NOT a.attisdropped ORDER BY c.relname,a.attnum`,
  constraints:`SELECT c.relname AS table,k.conname AS name,k.contype::text AS type,k.convalidated AS validated,k.condeferrable AS deferrable,k.condeferred AS deferred,pg_get_constraintdef(k.oid,true) AS definition FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname<>'_prisma_migrations' ORDER BY c.relname,k.conname`,
  indexes:`SELECT t.relname AS table,c.relname AS name,pg_get_indexdef(i.indexrelid) AS definition,i.indisvalid AS valid FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_class t ON t.oid=i.indrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname=$1 AND t.relname<>'_prisma_migrations' ORDER BY t.relname,c.relname`,
  sequences:`SELECT sequencename AS name,data_type::text,start_value::text,increment_by::text,max_value::text,min_value::text,cache_size::text,cycle FROM pg_sequences WHERE schemaname=$1 AND sequencename NOT LIKE '_prisma_migrations%' ORDER BY sequencename`,
  types:`SELECT t.typname AS name,e.enumlabel AS label,e.enumsortorder::text AS position FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace JOIN pg_enum e ON e.enumtypid=t.oid WHERE n.nspname=$1 ORDER BY t.typname,e.enumsortorder`,
  functions:`SELECT p.proname AS name,pg_get_function_identity_arguments(p.oid) AS args,pg_get_functiondef(p.oid) AS definition,p.prosecdef AS security_definer,p.provolatile::text AS volatility FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1 AND p.prokind IN ('f','p') AND NOT EXISTS(SELECT 1 FROM pg_depend d WHERE d.objid=p.oid AND d.deptype='e') ORDER BY p.proname,pg_get_function_identity_arguments(p.oid)`,
  triggers:`SELECT c.relname AS table,t.tgname AS name,pg_get_triggerdef(t.oid,true) AS definition,t.tgenabled::text AS enabled FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND NOT t.tgisinternal ORDER BY c.relname,t.tgname`,
  policies:`SELECT tablename AS table,policyname AS name,permissive,roles,cmd,qual,with_check FROM pg_policies WHERE schemaname=$1 ORDER BY tablename,policyname`,
  grants:`SELECT c.relname AS name,c.relkind::text AS kind,CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END AS grantee,x.privilege_type,x.is_grantable FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault(CASE WHEN c.relkind='S' THEN 's'::"char" ELSE 'r'::"char" END,c.relowner))) x WHERE n.nspname=$1 AND c.relkind IN ('r','p','S') AND c.relname NOT LIKE '_prisma_migrations%' ORDER BY c.relname,grantee,x.privilege_type`,
  functionGrants:`SELECT p.proname AS name,pg_get_function_identity_arguments(p.oid) AS args,CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END AS grantee,x.privilege_type,x.is_grantable FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f'::"char",p.proowner))) x WHERE n.nspname=$1 AND NOT EXISTS(SELECT 1 FROM pg_depend d WHERE d.objid=p.oid AND d.deptype='e') ORDER BY p.proname,grantee,x.privilege_type`,
  publications:`SELECT v.pubname,v.tablename AS table,v.attnames,v.rowfilter,(r.prattrs IS NOT NULL) AS explicit_columns,p.puballtables AS all_tables FROM pg_publication_tables v JOIN pg_publication p ON p.pubname=v.pubname JOIN pg_namespace n ON n.nspname=v.schemaname JOIN pg_class c ON c.relnamespace=n.oid AND c.relname=v.tablename LEFT JOIN pg_publication_rel r ON r.prpubid=p.oid AND r.prrelid=c.oid WHERE v.schemaname=$1 ORDER BY v.pubname,v.tablename`,
  extensions:`SELECT e.extname AS name,e.extversion AS version,n.nspname AS schema FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE $1::text IS NOT NULL ORDER BY e.extname`,
  extensionObjects:`SELECT n.nspname AS schema,c.opcname AS name,'opclass'::text AS kind FROM pg_opclass c JOIN pg_namespace n ON n.oid=c.opcnamespace JOIN pg_depend d ON d.objid=c.oid AND d.classid='pg_opclass'::regclass AND d.deptype='e' WHERE $1::text IS NOT NULL ORDER BY n.nspname,c.opcname`,
}
async function captureInventory(db,schema){
  const inventory={}
  for(const [kind,sql]of Object.entries(queries))inventory[kind]=await db.$queryRawUnsafe(sql,schema)
  return inventory
}
function compareInventory(actual,expected,{sourceSchema='public',targetSchema='public',exclude=[]}={}){
  const normalize=(value,schema,kind)=>{
    // Array order preserves logical order; physical attnum holes do not survive a rebuild.
    if(kind==='columns'&&Array.isArray(value))value=value.map(({position,...column})=>column)
    // Enum numeric sort slots are physical; the ordered labels are the contract.
    if(kind==='types'&&Array.isArray(value))value=value.map(({position,...type})=>type)
    if(['constraints','indexes'].includes(kind)&&Array.isArray(value))value=value.map(o=>({...o,definition:normalizedDefinition(o.definition)}))
    let text=JSON.stringify(canonical(value))
    if(!['extensions','extensionObjects'].includes(kind)){
      const protectedNames=expected.extensionObjects||[]
      protectedNames.forEach((o,i)=>{for(const spelling of [`${o.schema}.${o.name}`,`${identifier(o.schema)}.${identifier(o.name)}`])text=text.split(JSON.stringify(spelling).slice(1,-1)).join(`@@EXT${i}@@`)})
      for(const spelling of [`${schema}.`,`${identifier(schema)}.`])text=text.split(JSON.stringify(spelling).slice(1,-1)).join('@APP.')
    }
    return text
  }
  return [...new Set([...Object.keys(actual),...Object.keys(expected)])].filter(k=>!exclude.includes(k)&&normalize(actual[k],targetSchema,k)!==normalize(expected[k],sourceSchema,k))
}
async function captureRows(db,schema,projections){
  const result={}
  for(const [table,columns]of Object.entries(projections)){
    const rows=await db.$queryRawUnsafe(`SELECT row_to_json(t)::text AS row FROM (SELECT ${columns.map(identifier).join(',')} FROM ${identifier(schema)}.${identifier(table)}) t`)
    result[table]={count:rows.length,hash:fingerprintRows(rows.map(r=>r.row))}
  }
  return result
}
module.exports={captureInventory,compareInventory,captureRows,fingerprintRows,identifier,hash,canonical}
