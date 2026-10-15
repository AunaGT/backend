function roleNormalizationFixture({ shared = false, adminAlias = false } = {}) {
  return { companyA:'company-a', companyB:'company-b', userA:'user-a',
    roles:[
      {id:73,name:'admin',company_id:null,description:null,permissions:[]},
      {id:61,name:'Bodega',company_id:null,description:null,permissions:[{permission_id:11,permission:{code:'products.view'}}]},
      {id:88,name:'Ventas',company_id:'company-b',description:null,permissions:[{permission_id:12,permission:{code:'sales.view'}}]},
      ...(adminAlias ? [{id:67,name:'Admin',company_id:null,description:null,permissions:[]}] : []),
    ], users:[{id:'user-a',role_id:61}],
    memberships:[{user_id:'user-a',company_id:'company-a',role_id:null,status:'ACTIVE'},
      {user_id:'user-a',company_id:'company-b',role_id:shared ? null : 88,status:'BLOCKED'}],
    branches:[{user_id:'user-a',branch_id:'branch-a'}],
  }
}
function normalizationStore(initial) {
 let state=structuredClone(initial),nextId=100
 const match=(r,w)=>Object.entries(w||{}).every(([k,v])=>k==='OR'?v.some(x=>match(r,x)):v&&typeof v==='object'&&'in'in v?v.in.includes(r[k]):r[k]===v)
 const db={
  $queryRaw:async()=>[{column_name:'system_key'}],
  role:{findMany:async({where}={})=>structuredClone(state.roles.filter(r=>match(r,where))),findFirst:async({where})=>structuredClone(state.roles.find(r=>match(r,where))||null),
   createMany:async({data})=>{for(const r of data)state.roles.push({id:nextId++,permissions:[],revision:0,...r})},
   update:async({where,data})=>{const r=state.roles.find(r=>r.id===where.id);Object.assign(r,data);return r},
   upsert:async({where,create})=>{let r=state.roles.find(r=>match(r,where));if(!r){r={id:nextId++,permissions:[],...create};state.roles.push(r)}return r}},
  rolePermission:{createMany:async({data})=>{for(const p of data){const r=state.roles.find(r=>r.id===p.role_id),original=state.roles.flatMap(r=>r.permissions).find(x=>x.permission_id===p.permission_id);r.permissions.push({permission_id:p.permission_id,permission:structuredClone(original.permission)})}}},
  user:{findMany:async()=>structuredClone(state.users),updateMany:async({where,data})=>{for(const u of state.users.filter(r=>match(r,where)))Object.assign(u,data)}},
  userCompany:{findMany:async()=>structuredClone(state.memberships),update:async({where,data})=>{if(db.failWrite)throw Error('write failed');Object.assign(state.memberships.find(m=>match(m,where.user_id_company_id)),data)},updateMany:async({where,data})=>{for(const m of state.memberships.filter(r=>match(r,where)))Object.assign(m,data)}},
  userBranch:{findMany:async()=>structuredClone(state.branches)},
  $transaction:async run=>{const before=structuredClone(state);try{return await run(db)}catch(e){state=before;throw e}},
 }
 return {db,snapshot:()=>structuredClone(state)}
}
module.exports={roleNormalizationFixture,normalizationStore}
