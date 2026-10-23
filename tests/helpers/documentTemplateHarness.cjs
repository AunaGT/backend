const {randomUUID}=require('node:crypto')
function templateDb(){
  const state={templates:[],versions:[],defaults:[],events:[],artifacts:[],assets:[],settings:[]}
  function matches(row,where={}){return Object.entries(where).every(([k,v])=>{
    if(k==='AND')return v.every(w=>matches(row,w))
    if(k==='OR')return v.some(w=>matches(row,w))
    if(k.includes('_')&&row[k]===undefined&&v&&typeof v==='object'&&!Array.isArray(v)&&!('in' in v))return matches(row,v)
    if(v&&typeof v==='object'&&!Array.isArray(v)&&!(v instanceof Date)){
      if('in' in v)return v.in.includes(row[k]);if('not' in v)return row[k]!==v.not;if('gt' in v)return row[k]>v.gt
    }
    return row[k]===v
  })}
  const db={state,$executeRaw:async()=>1,$queryRaw:async()=>[],$transaction:async fn=>{const old=structuredClone(state);try{return await fn(db)}catch(e){Object.assign(state,old);throw e}}}
  for(const [name,key] of Object.entries({documentTemplate:'templates',documentTemplateVersion:'versions',documentTemplateDefault:'defaults',documentEvent:'events',documentArtifact:'artifacts',documentTemplateAsset:'assets',systemSetting:'settings'})) {
    const rows=()=>state[key]
    const enrich=(r,include)=>r&&structuredClone({...r,...(include?.versions?{versions:state.versions.filter(v=>v.template_id===r.id).sort((a,b)=>b.number-a.number)}:{}),...(include?.version?{version:state.versions.find(v=>v.id===r.version_id)}:{}),...(include?.snapshot?{snapshot:r.snapshot}:{})})
    db[name]={
      findFirst:async({where,include}={})=>enrich(rows().find(r=>matches(r,where)),include),
      findUnique:async args=>db[name].findFirst(args),
      findMany:async({where,include,skip=0,take}={})=>rows().filter(r=>matches(r,where)).slice(skip,take?skip+take:undefined).map(r=>enrich(r,include)),
      count:async({where}={})=>rows().filter(r=>matches(r,where)).length,
      create:async({data})=>{const row={id:randomUUID(),revision:1,state:name==='documentTemplateVersion'?'DRAFT':'ACTIVE',created_at:new Date(),updated_at:new Date(),...structuredClone(data)};rows().push(row);return structuredClone(row)},
      updateMany:async({where,data})=>{let count=0;for(const row of rows())if(matches(row,where)){for(const [k,v] of Object.entries(data))row[k]=v&&typeof v==='object'&&'increment' in v?row[k]+v.increment:structuredClone(v);count++}return {count}},
      update:async({where,data})=>{await db[name].updateMany({where,data});return db[name].findFirst({where})},
      upsert:async({where,create,update})=>{const found=rows().find(r=>matches(r,where));return found?db[name].update({where:{id:found.id},data:update}):db[name].create({data:create})},
    }
  }
  return db
}
module.exports={templateDb}
