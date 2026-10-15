const {expandPermissions}=require('../../../config/permissionDeps')
const {createHash}=require('node:crypto')
const legacyAdmin=r=>r.company_id==null&&r.name.toLowerCase()==='admin'
const normalizeName=name=>name.trim().toLowerCase()
function planRoleNormalization(snapshot) {
 const roles=new Map(snapshot.roles.map(r=>[r.id,r])),users=new Map(snapshot.users.map(u=>[u.id,u]))
 const admins=snapshot.roles.filter(legacyAdmin).sort((a,b)=>(b.name==='admin')-(a.name==='admin')||a.id-b.id)
 const canonical=admins.find(r=>r.system_key==='ADMIN')||admins[0]
 const plan={canonicalAdminId:canonical?.id??null,adminAliasIds:admins.filter(r=>r.id!==canonical?.id).map(r=>r.id).sort((a,b)=>a-b),copies:[],membershipChanges:[],unresolved:[],conflicts:[]}
 const localNames=new Map(),origins=new Map(),used=new Set(),copyKeys=new Set()
 for(const r of snapshot.roles) {
  if(['admin','administrador'].includes(normalizeName(r.name))&&!legacyAdmin(r))plan.conflicts.push({roleId:r.id,reason:'Nombre reservado ambiguo'})
  if(r.company_id) {
   const key=`${r.company_id}:${normalizeName(r.name)}`
   if(localNames.has(key))plan.conflicts.push({roleId:r.id,reason:'Nombre local duplicado'})
   localNames.set(key,r.id)
   if(r.legacy_role_id!=null){const key=`${r.company_id}:${r.legacy_role_id}`;if(origins.has(key))plan.conflicts.push({roleId:r.id,reason:'Procedencia duplicada'});origins.set(key,r.id)}
  }
 }
 for(const m of snapshot.memberships) {
  const user=users.get(m.user_id),id=m.role_id??user?.role_id,r=roles.get(id)
  if(!user||!r){plan.conflicts.push({userId:m.user_id,companyId:m.company_id,reason:'Referencia inexistente'});continue}
  if(r.company_id&&r.company_id!==m.company_id){plan.conflicts.push({userId:m.user_id,companyId:m.company_id,reason:'Rol de otra empresa'});continue}
  if(r.company_id||legacyAdmin(r))continue
  used.add(r.id)
  const key=`${m.company_id}:${r.id}`,nameKey=`${m.company_id}:${normalizeName(r.name)}`
  if(!origins.has(key)&&localNames.has(nameKey))plan.conflicts.push({roleId:r.id,companyId:m.company_id,reason:'Colisión con rol local'})
  if(!origins.has(key)&&!copyKeys.has(key)) {
   copyKeys.add(key)
   plan.copies.push({sourceId:r.id,companyId:m.company_id,name:r.name,description:r.description??null,permissionIds:r.permissions.map(p=>p.permission_id).sort((a,b)=>a-b)})
  }
  plan.membershipChanges.push({userId:m.user_id,companyId:m.company_id,sourceId:r.id})
 }
 for(const u of snapshot.users)if(!roles.has(u.role_id))plan.conflicts.push({userId:u.id,reason:'Referencia heredada inexistente'})
 for(const r of snapshot.roles)if(!r.company_id&&!legacyAdmin(r)&&!used.has(r.id))plan.unresolved.push({roleId:r.id,reason:'Sin empresa de uso inferible; conservado'})
 plan.copies.sort((a,b)=>a.companyId.localeCompare(b.companyId)||a.sourceId-b.sourceId)
 plan.membershipChanges.sort((a,b)=>a.companyId.localeCompare(b.companyId)||a.userId.localeCompare(b.userId))
 return plan
}
async function readRoleSnapshot(db) {
 const columns=await db.$queryRaw`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='roles'`
 const evolved=columns.some(c=>c.column_name==='system_key')
 const [roles,users,memberships,branches]=await Promise.all([
  db.role.findMany({orderBy:{id:'asc'},select:{id:true,name:true,description:true,company_id:true,...(evolved?{system_key:true,legacy_role_id:true,revision:true}:{}),permissions:{orderBy:{permission_id:'asc'},select:{permission_id:true,permission:{select:{code:true}}}}}}),
  db.user.findMany({orderBy:{id:'asc'},select:{id:true,role_id:true}}),
  db.userCompany.findMany({orderBy:[{company_id:'asc'},{user_id:'asc'}],select:{user_id:true,company_id:true,role_id:true,status:true}}),
  db.userBranch.findMany({orderBy:[{user_id:'asc'},{branch_id:'asc'}],select:{user_id:true,branch_id:true}}),
 ])
 return {roles,users,memberships,branches}
}
function snapshotHash(s) {
 const data={...s,roles:s.roles.map(({id,name,description,company_id,permissions})=>({id,name,description,company_id,permissions}))}
 return createHash('sha256').update(JSON.stringify(data)).digest('hex')
}
function accessSnapshot(s) {
 const roles=new Map(s.roles.map(r=>[r.id,r])),users=new Map(s.users.map(u=>[u.id,u]))
 return s.memberships.map(m=>{
  const r=roles.get(m.role_id??users.get(m.user_id)?.role_id)
  return {user_id:m.user_id,company_id:m.company_id,status:m.status,access:!r?'MISSING':legacyAdmin(r)?'ADMIN':expandPermissions(r.permissions.map(p=>p.permission.code)).sort()}
 }).sort((a,b)=>`${a.company_id}:${a.user_id}`.localeCompare(`${b.company_id}:${b.user_id}`))
}
function verifyRoleNormalization(before,after) {
 const changes=[]
 if(JSON.stringify(accessSnapshot(before))!==JSON.stringify(accessSnapshot(after)))changes.push('Cambió el acceso efectivo o estado de una membresía')
 if(JSON.stringify(before.branches)!==JSON.stringify(after.branches))changes.push('Cambiaron sucursales')
 if(JSON.stringify(before.users.map(u=>u.id))!==JSON.stringify(after.users.map(u=>u.id)))changes.push('Cambiaron usuarios')
 return {ok:changes.length===0,changes,unresolved:planRoleNormalization(after).unresolved}
}
async function applyRoleNormalization(tx,snapshot) {
 const plan=planRoleNormalization(snapshot)
 if(plan.conflicts.length)throw Object.assign(new Error('Conflictos de normalización; no se aplicó ningún cambio'),{conflicts:plan.conflicts})
 let adminId=plan.canonicalAdminId
 if(adminId)await tx.role.update({where:{id:adminId},data:{name:'admin',system_key:'ADMIN'}})
 else adminId=(await tx.role.upsert({where:{system_key:'ADMIN'},update:{},create:{name:'admin',system_key:'ADMIN'}})).id
 if(plan.adminAliasIds.length) {
  await tx.user.updateMany({where:{role_id:{in:plan.adminAliasIds}},data:{role_id:adminId}})
  await tx.userCompany.updateMany({where:{role_id:{in:plan.adminAliasIds}},data:{role_id:adminId}})
 }
 if(plan.copies.length)await tx.role.createMany({data:plan.copies.map(c=>({company_id:c.companyId,legacy_role_id:c.sourceId,name:c.name,description:c.description}))})
 const local=await tx.role.findMany({where:{legacy_role_id:{in:[...new Set(plan.membershipChanges.map(c=>c.sourceId))]}}})
 const bySource=new Map(local.map(r=>[`${r.company_id}:${r.legacy_role_id}`,r.id]))
 const permissionRows=plan.copies.flatMap(c=>c.permissionIds.map(permission_id=>({role_id:bySource.get(`${c.companyId}:${c.sourceId}`),permission_id})))
 if(permissionRows.length)await tx.rolePermission.createMany({data:permissionRows,skipDuplicates:true})
 for(const c of plan.membershipChanges)await tx.userCompany.update({where:{user_id_company_id:{user_id:c.userId,company_id:c.companyId}},data:{role_id:bySource.get(`${c.companyId}:${c.sourceId}`)}})
 const after=await readRoleSnapshot(tx),verification=verifyRoleNormalization(snapshot,after)
 if(!verification.ok)throw Object.assign(new Error('La normalización alteraría accesos; transacción cancelada'),{verification})
 return {plan,verification,after}
}
module.exports={planRoleNormalization,readRoleSnapshot,snapshotHash,verifyRoleNormalization,applyRoleNormalization}
