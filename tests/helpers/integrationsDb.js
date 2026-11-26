const { randomUUID } = require('node:crypto')
const COMPANY='11111111-1111-4111-8111-111111111111', OWNER='22222222-2222-4222-8222-222222222222', BRANCH='33333333-3333-4333-8333-333333333333'
function fixture(){
 const rows=[],events=[],identities=[]; let queue=Promise.resolve(),brokenAudit=false
 const match=(r,w={})=>Object.entries(w).every(([k,v])=>k==='AND'?v.every(x=>match(r,x)):k==='OR'?v.some(x=>match(r,x)):v&&typeof v==='object'&&!Array.isArray(v)&&!(v instanceof Date)?Object.entries(v).every(([op,val])=>op==='gt'?r[k]>val:op==='lt'?r[k]<val:op==='lte'?r[k]!=null&&r[k]<=val:op==='not'?r[k]!==val:op==='in'?val.includes(r[k]):op==='has'?r[k]?.includes(val):op==='mode'?true:op==='contains'?String(r[k]??'').toLowerCase().includes(val.replace(/\\([\\%_])/g,'$1').toLowerCase()):false):r[k]===v)
 const model=items=>({findFirst:async({where})=>items.find(r=>match(r,where))||null,findUnique:async({where})=>items.find(r=>match(r,where))||null,findMany:async({where,skip=0,take=100,orderBy=[]}={})=>items.filter(r=>match(r,where)).sort((a,b)=>{for(const order of orderBy){const [key,dir]=Object.entries(order)[0],delta=a[key]<b[key]?-1:a[key]>b[key]?1:0;if(delta)return dir==='desc'?-delta:delta}return 0}).slice(skip,skip+take),count:async({where})=>items.filter(r=>match(r,where)).length,create:async({data})=>{if(items===events&&brokenAudit)throw Error('audit failure');const row={id:randomUUID(),created_at:new Date(),revoked_at:null,paused_at:null,last_used_at:null,...data};if(data.branches?.create)row.branches=data.branches.create.map(b=>({branch_id:b.branch_id,branch:{id:b.branch_id,name:'Principal'}}));items.push(row);return row},updateMany:async({where,data})=>{let count=0;for(const r of items)if(match(r,where)){Object.assign(r,data);count++}return{count}}})
 const db={integrationCredential:model(rows),integrationIdentity:model(identities),integrationAuditEvent:model(events),$executeRaw:async()=>0,
  userCompany:{findUnique:async()=>({status:'ACTIVE',company:{active:true},user:{name:'Ana'},role:{name:'admin',system_key:'ADMIN',company_id:null,permissions:[]}}),findMany:async()=>[{user_id:OWNER,user:{id:OWNER,name:'Ana'}}]},
  userBranch:{findMany:async()=>[{branch:{id:BRANCH,company_id:COMPANY,active:true,name:'Principal'}}]},companyModule:{findMany:async()=>[]},systemSetting:{findMany:async()=>[]}}
 db.$transaction=run=>{const p=queue.then(async()=>{const before=structuredClone([rows,events,identities]);try{return await run(db)}catch(e){rows.splice(0,rows.length,...before[0]);events.splice(0,events.length,...before[1]);identities.splice(0,identities.length,...before[2]);throw e}});queue=p.catch(()=>{});return p}
 return {db,rows,events,identities,breakAudit:()=>{brokenAudit=true}}
}
const scope={companyId:COMPANY,actorId:OWNER,isAdmin:true,permissions:[],branchId:BRANCH}
const input={name:'Web',ownerId:OWNER,scopes:['products.read'],branchIds:[BRANCH],days:90}
module.exports={fixture,scope,input,COMPANY,OWNER,BRANCH}
