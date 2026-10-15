async function ensureSystemAdmin(db) {
 const roles=await db.role.findMany({where:{company_id:null},select:{id:true,name:true,company_id:true,system_key:true}})
 if(!roles.some(r=>r.system_key==='ADMIN')&&roles.some(r=>['admin','administrador'].includes(r.name.trim().toLowerCase())))throw new Error('Normaliza los administradores heredados antes de ejecutar la semilla')
 return db.role.upsert({where:{system_key:'ADMIN'},update:{},create:{name:'admin',system_key:'ADMIN'}})
}
module.exports={ensureSystemAdmin}
