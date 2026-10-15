function roleServiceFixture() {
 let rows=[{id:73,name:'admin',system_key:'ADMIN',company_id:null,revision:0,permissions:[]},{id:101,name:'Bodega',company_id:'a',revision:0,permissions:[]},{id:102,name:'Ventas',company_id:'b',revision:0,permissions:[]}],seq=103
 const users=[{id:'actor',role_id:73}],memberships=[{user_id:'actor',company_id:'a',role_id:73,status:'ACTIVE'}]
 const perms=[{id:11,code:'products.view',name:'Ver productos'},{id:12,code:'warehouses.view',name:'Ver almacenes'}],events=[]
 const match=(r,w={})=>Object.entries(w).every(([k,v])=>k==='OR'?v.some(x=>match(r,x)):k==='AND'?v.every(x=>match(r,x)):v&&typeof v==='object'?'in'in v?v.in.includes(r[k]):'contains'in v?String(r[k]).toLowerCase().includes(v.contains.toLowerCase()):match(r[k]||{},v):r[k]===v)
 const db={$queryRaw:async()=>[{id:'a'}],
  role:{findMany:async({where}={})=>structuredClone(rows.filter(r=>match(r,where))),count:async({where})=>rows.filter(r=>match(r,where)).length,findFirst:async({where})=>structuredClone(rows.find(r=>match(r,where))||null),findUnique:async({where})=>structuredClone(rows.find(r=>r.id===where.id)||null),
   create:async({data})=>{if(rows.some(r=>r.company_id===data.company_id&&r.name.toLowerCase()===data.name.toLowerCase()))throw Object.assign(Error('unique'),{code:'P2002'});const r={id:seq++,revision:0,permissions:[],...data};rows.push(r);return r},
   update:async({where,data})=>{const r=rows.find(r=>r.id===where.id);Object.assign(r,{...data,revision:r.revision+1});return r},delete:async({where})=>{rows=rows.filter(r=>r.id!==where.id)}},
  permission:{findMany:async({where}={})=>perms.filter(r=>match(r,where))},
  rolePermission:{deleteMany:async({where})=>{rows.find(r=>r.id===where.role_id).permissions=[]},createMany:async({data})=>{for(const p of data)rows.find(r=>r.id===p.role_id).permissions.push({permission:perms.find(x=>x.id===p.permission_id)})}},
  user:{findUnique:async({where})=>{const u=users.find(u=>u.id===where.id);return u?{...u,role:rows.find(r=>r.id===u.role_id),user_companies:memberships.filter(m=>m.user_id===u.id).map(m=>({...m,role:rows.find(r=>r.id===m.role_id)}))}:null},findMany:async({where}={})=>users.filter(r=>match(r,where)),count:async({where})=>users.filter(r=>match(r,where)).length},
  userCompany:{findMany:async({where}={})=>memberships.filter(m=>match(m,where)).map(m=>({...m,user:users.find(u=>u.id===m.user_id)})),count:async({where})=>memberships.filter(r=>match(r,where)).length},
  userAccessEvent:{create:async({data})=>events.push(data)},
  $transaction:async fn=>{const old=structuredClone(rows);try{return await fn(db)}catch(e){rows=old;throw e}},
 }
 return {db,req:{companyId:'a',user:{sub:'actor'},query:{}},rows:()=>rows,users,memberships,events}
}
module.exports={roleServiceFixture}
