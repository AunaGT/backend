const {randomUUID}=require('node:crypto')
function fixture(){
 const templates=[],versions=[],receipts=[],audits=[],assets=[],sections=[],defaults=[],policies=[]
 const collections=[templates,versions,receipts,audits,assets,sections,defaults,policies]
 const matches=(r,w)=>Object.entries(w||{}).every(([k,v])=>k==='OR'?v.some(x=>matches(r,x)):k==='AND'?v.every(x=>matches(r,x)):typeof v==='object'&&v!==null?Object.entries(v).every(([key,value])=>key==='not'?r[k]!==value:key==='in'?value.includes(r[k]):key==='lt'?r[k]<value:key==='gte'?r[k]>=value:r[key]===value):r[k]===v)
 const apply=(r,data)=>{for(const[k,v]of Object.entries(data))r[k]=v?.increment!==undefined?r[k]+v.increment:structuredClone(v);return r}
 const model=rows=>({findFirst:async({where,orderBy})=>{const out=rows.filter(r=>matches(r,where));if(orderBy?.number==='desc')out.sort((a,b)=>b.number-a.number);return out[0]||null},findUnique:async({where})=>rows.find(r=>matches(r,Object.values(where)[0]))||null,count:async({where}={})=>rows.filter(r=>matches(r,where)).length,findMany:async({where,skip=0,take=100}={})=>rows.filter(r=>matches(r,where)).slice(skip,skip+take),aggregate:async({where}={})=>({_sum:{bytes:rows.filter(r=>matches(r,where)).reduce((n,r)=>n+(r.bytes||0),0)}}),create:async({data})=>{const row={id:randomUUID(),created_at:new Date(),updated_at:new Date(),...structuredClone(data)};rows.push(row);return row},updateMany:async({where,data})=>{let count=0;for(const r of rows)if(matches(r,where)){apply(r,data);count++}return{count}},upsert:async({where,create,update})=>{const r=rows.find(r=>matches(r,Object.values(where)[0]));if(r)return apply(r,update);const row=structuredClone(create);rows.push(row);return row},deleteMany:async({where}={})=>{let count=0;for(let i=rows.length-1;i>=0;i--)if(matches(rows[i],where)){rows.splice(i,1);count++}return{count}}})
 const db={portalTemplate:model(templates),portalTemplateVersion:model(versions),portalWriteReceipt:model(receipts),portalAudit:model(audits),portalAsset:model(assets),portalSavedSection:model(sections),portalTemplateDefault:model(defaults),portalCodePolicy:model(policies),$executeRaw:async()=>0}
 let queue=Promise.resolve()
 db.$transaction=fn=>{const run=queue.then(async()=>{const before=collections.map(x=>structuredClone(x));try{return await fn(db)}catch(e){collections.forEach((x,i)=>x.splice(0,x.length,...before[i]));throw e}});queue=run.catch(()=>{});return run}
 return{db,templates,versions,receipts,audits,assets,sections,defaults,policies}
}
const scope={companyId:'company-a',actorId:'actor',permissions:['customer_pages.manage'],isAdmin:false}
module.exports={fixture,scope}
