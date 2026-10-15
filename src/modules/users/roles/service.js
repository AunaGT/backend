const {effectiveUser,permissions,listQuery}=require('../../../services/userAccess')
const {expandPermissions}=require('../../../config/permissionDeps')
const {requireCompany}=require('../../../middlewares/tenant')
const {isSystemAdmin,visibleRolesWhere,roleId,roleError,parseRoleSave,parseRoleDelete,resolveVisibleRole}=require('./policy')
const roleInclude={permissions:{include:{permission:true}}}
async function lockRoleCompany(tx,companyId) {
 const rows=await tx.$queryRaw`SELECT id FROM companies WHERE id=${companyId}::uuid FOR UPDATE`
 if(!rows.length)roleError(404,'COMPANY_UNAVAILABLE','Empresa no disponible')
}
async function freshActor(tx,req,required=['roles.manage']) {
 const user=await tx.user.findUnique({where:{id:req.user.sub},include:{role:{include:roleInclude},user_companies:{include:{role:{include:roleInclude}}}}})
 if(!user)roleError(401,'SESSION_EXPIRED','La sesión ha caducado')
 const actor=effectiveUser(user,requireCompany(req))
 if(!isSystemAdmin(actor.role)&&!required.some(p=>actor.permissions.includes(p)))roleError(403,'FORBIDDEN','No tienes permiso para esta operación')
 return actor
}
function grant(actor,role) {
 if(isSystemAdmin(actor.role))return
 if(isSystemAdmin(role)||permissions(role).some(p=>!actor.permissions.includes(p)))roleError(403,'GRANT_FORBIDDEN','No puedes conceder permisos superiores a los tuyos')
}
async function resolveAssignableRole(tx,req,id) {
 const actor=await freshActor(tx,req,['users.create','users.edit','users.import','companies.manage','roles.manage'])
 const role=await resolveVisibleRole(tx,requireCompany(req),id,{alias:false})
 if(!role)roleError(400,'ROLE_UNAVAILABLE','Rol no disponible en esta empresa')
 grant(actor,role);return role
}
async function roleDtos(db,req,roles) {
 const ids=roles.map(r=>r.id),companyId=requireCompany(req)
 const [members,refs]=await Promise.all([
  db.userCompany.findMany({where:{company_id:companyId},select:{user_id:true,role_id:true,user:{select:{role_id:true}}}}),
  db.user.findMany({where:{role_id:{in:ids}},select:{role_id:true}}),
 ])
 const counts=new Map(),references=new Map()
 for(const m of members){const id=m.role_id??m.user.role_id;counts.set(id,(counts.get(id)||0)+1)}
 for(const u of refs)references.set(u.role_id,(references.get(u.role_id)||0)+1)
 return roles.map(role=>{
  const protectedRole=isSystemAdmin(role),usersCount=counts.get(role.id)||0,legacyReferenceCount=role.company_id?(references.get(role.id)||0):0
  const reason=protectedRole?'El administrador del sistema está protegido':req.user.role_id===role.id?'No puedes eliminar tu propio rol':usersCount?'Reasigna sus usuarios desde Usuarios antes de eliminar':legacyReferenceCount?'Tiene referencias heredadas: reasigna las cuentas desde Usuarios':null
  return {id:role.id,name:role.name,description:role.description??null,company_id:role.company_id,protected:protectedRole,revision:role.revision,permissions:role.permissions.map(p=>p.permission),usersCount,legacyReferenceCount,canDelete:!reason,deleteBlockedReason:reason}
 })
}
async function listRoles(db,req,{paged=false}={}) {
 const scope=visibleRolesWhere(requireCompany(req)),query=req.query||{},where={AND:[scope]}
 if(query.search)where.AND.push({name:{contains:String(query.search),mode:'insensitive'}})
 if(query.module)where.AND.push({permissions:{some:{permission:{code:{startsWith:`${query.module}.`}}}}})
 if(query.kind==='protected')where.AND.push({system_key:'ADMIN'})
 if(query.kind==='custom')where.AND.push({company_id:req.companyId})
 if(!paged)return roleDtos(db,req,await db.role.findMany({where:scope,orderBy:[{name:'asc'},{id:'asc'}],include:roleInclude}))
 const {page,pageSize}=listQuery({...query,pageSize:query.pageSize??10}),totalItems=await db.role.count({where}),totalPages=Math.max(1,Math.ceil(totalItems/pageSize)),safePage=Math.min(page,totalPages)
 const [rows,totalRoles,assignedUsers,codes]=await Promise.all([
  db.role.findMany({where,skip:(safePage-1)*pageSize,take:pageSize,orderBy:[{name:'asc'},{id:'asc'}],include:roleInclude}),db.role.count({where:scope}),db.userCompany.count({where:{company_id:req.companyId}}),db.permission.findMany({select:{code:true}}),
 ])
 return {items:await roleDtos(db,req,rows),page:safePage,pageSize,totalItems,totalPages,nextPage:safePage<totalPages?safePage+1:null,prevPage:safePage>1?safePage-1:null,stats:{totalRoles,assignedUsers,modules:new Set(codes.map(p=>p.code.split('.')[0])).size}}
}
async function getRole(db,req,id) {
 const role=await resolveVisibleRole(db,requireCompany(req),id)
 if(!role)roleError(404,'ROLE_UNAVAILABLE','Rol no encontrado en esta empresa')
 return (await roleDtos(db,req,[role]))[0]
}
async function editableRole(tx,req,id,expectedRevision,actor) {
 const companyId=requireCompany(req)
 await tx.$queryRaw`SELECT id FROM roles WHERE id=${id} AND (company_id=${companyId}::uuid OR system_key='ADMIN') FOR UPDATE`
 const role=await resolveVisibleRole(tx,companyId,id,{alias:false})
 if(!role)roleError(404,'ROLE_UNAVAILABLE','Rol no encontrado en esta empresa')
 if(isSystemAdmin(role))roleError(403,'PROTECTED_ROLE','El administrador del sistema está protegido')
 if(actor.role_id===id)roleError(409,'OWN_ROLE','No puedes modificar ni eliminar tu propio rol')
 if(role.revision!==expectedRevision)roleError(409,'STALE_ROLE','Otro usuario modificó este rol. Recarga y revisa los cambios')
 return role
}
async function mutate(db,run) {
 try{return await db.$transaction(run,{timeout:30000,maxWait:5000})}catch(e){
  if(e.code==='P2002'&&(!e.meta?.target||String(e.meta.target).includes('name')))roleError(409,'ROLE_NAME_EXISTS','Ya existe un rol con ese nombre en la empresa')
  if(e.code==='P2003')roleError(409,'ROLE_IN_USE','El rol tiene asignaciones o referencias; reasígnalas antes de eliminar')
  throw e
 }
}
const audit=(tx,req,role,action)=>tx.userAccessEvent.create({data:{company_id:requireCompany(req),user_id:req.user.sub,actor_id:req.user.sub,action:`${action} rol #${role.id} rev ${role.revision}`}})
async function saveRole(db,req,id,raw) {
 const creating=id==null,input=parseRoleSave(raw,{creating});if(!creating)id=roleId(id)
 return mutate(db,async tx=>{
  await lockRoleCompany(tx,requireCompany(req));const actor=await freshActor(tx,req)
  if(!creating)await editableRole(tx,req,id,input.expectedRevision,actor)
  const codes=expandPermissions(input.permissions),all=await tx.permission.findMany({where:{code:{in:codes}}})
  if(all.length!==new Set(codes).size)roleError(400,'UNKNOWN_PERMISSION','Hay permisos desconocidos')
  grant(actor,{permissions:all})
  const data={name:input.name,description:input.description}
  const saved=creating?await tx.role.create({data:{...data,company_id:requireCompany(req)}}):await tx.role.update({where:{id},data:{...data,revision:{increment:1}}})
  await tx.rolePermission.deleteMany({where:{role_id:saved.id}})
  if(all.length)await tx.rolePermission.createMany({data:all.map(p=>({role_id:saved.id,permission_id:p.id}))})
  await audit(tx,req,saved,creating?'Creación':'Edición')
  return getRole(tx,{...req,user:actor},saved.id)
 })
}
async function deleteRole(db,req,id,raw) {
 id=roleId(id);const input=parseRoleDelete(raw)
 return mutate(db,async tx=>{
  await lockRoleCompany(tx,requireCompany(req));const actor=await freshActor(tx,req)
  const role=await editableRole(tx,req,id,input.expectedRevision,actor)
  const dto=(await roleDtos(tx,{...req,user:actor},[role]))[0]
  if(!dto.canDelete)roleError(409,'ROLE_IN_USE',dto.deleteBlockedReason)
  await tx.rolePermission.deleteMany({where:{role_id:id}});await tx.role.delete({where:{id}})
  await audit(tx,req,role,'Eliminación');return {id,message:'Rol eliminado'}
 })
}
async function releaseRoleFallback(tx,user,companyId,oldRole,newRole) {
 const [current]=await tx.$queryRaw`SELECT id,role_id FROM users WHERE id=${user.id}::uuid FOR UPDATE`
 if(!current)roleError(404,'USER_UNAVAILABLE','Usuario no disponible')
 if(current.role_id!==oldRole.id&&current.role_id!==oldRole.legacy_role_id)return
 await tx.userCompany.updateMany({where:{user_id:user.id,company_id:{not:companyId},role_id:null},data:{role_id:current.role_id}})
 await tx.user.update({where:{id:user.id},data:{role_id:newRole.id}})
}
module.exports={listRoles,getRole,saveRole,deleteRole,lockRoleCompany,resolveAssignableRole,freshActor,releaseRoleFallback}
