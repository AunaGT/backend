function roleError(status, code, message) { throw Object.assign(new Error(message), {status,code}) }
const isSystemAdmin = role => Boolean(role?.system_key === 'ADMIN' && role.company_id == null && role.name === 'admin')
const visibleRolesWhere = companyId => ({OR:[{company_id:companyId},{company_id:null,system_key:'ADMIN'}]})
function roleId(value) {
 const id=Number(value)
 if(!Number.isSafeInteger(id)||id<1)roleError(400,'INVALID_ROLE','Rol inválido')
 return id
}
function object(raw,keys) {
 if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).some(k=>!keys.includes(k)))roleError(400,'INVALID_ROLE','Datos de rol no válidos')
}
function revision(raw) {
 if(raw.expectedRevision===undefined)roleError(428,'REVISION_REQUIRED','Recarga el rol antes de guardar o eliminar')
 if(!Number.isSafeInteger(raw.expectedRevision)||raw.expectedRevision<0)roleError(400,'INVALID_REVISION','Revisión no válida')
 return raw.expectedRevision
}
function parseRoleSave(raw,{creating=false}={}) {
 object(raw,['name','description','permissions','expectedRevision'])
 if(typeof raw.name!=='string'||!raw.name.trim()||raw.name.trim().length>50||['admin','administrador'].includes(raw.name.trim().toLowerCase()))roleError(400,'INVALID_ROLE_NAME','Nombre de rol inválido o reservado')
 if(raw.description!=null&&(typeof raw.description!=='string'||raw.description.length>500))roleError(400,'INVALID_ROLE','Descripción inválida')
 if(!Array.isArray(raw.permissions)||raw.permissions.some(p=>typeof p!=='string'||!p||p.length>150))roleError(400,'INVALID_PERMISSION','Permisos inválidos')
 const result={name:raw.name.trim(),description:raw.description?.trim()||null,permissions:[...new Set(raw.permissions)]}
 if(!creating||raw.expectedRevision!==undefined)result.expectedRevision=revision(raw)
 return result
}
function parseRoleDelete(raw) {object(raw,['expectedRevision']);return {expectedRevision:revision(raw)}}
async function resolveVisibleRole(db,companyId,id,{alias=true}={}) {
 id=roleId(id)
 const include={permissions:{include:{permission:true}}}
 const direct=await db.role.findFirst({where:{id,...visibleRolesWhere(companyId)},include})
 if(direct)return direct
 if(!alias)return null
 const local=await db.role.findFirst({where:{company_id:companyId,legacy_role_id:id},include})
 if(local)return local
 const legacy=await db.role.findFirst({where:{id,company_id:null},select:{name:true}})
 if(legacy?.name.toLowerCase()==='admin')return db.role.findFirst({where:{company_id:null,system_key:'ADMIN'},include})
 return null
}
module.exports={roleError,isSystemAdmin,visibleRolesWhere,roleId,parseRoleSave,parseRoleDelete,resolveVisibleRole}
