const {withDevDb,devDbEnabled}=require('./salesDevFixture.cjs')
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{randomUUID}=require('node:crypto')
const companies=['00fcf315-a7dc-4807-a3c7-4c6d4eeeeaac','2a119b1d-c681-4126-a5f8-e0f5a0b6648a']
async function withRolesDevFixture(run) {
 return withDevDb(async db=>{
  const found=await db.company.findMany({where:{id:{in:companies}},select:{id:true,name:true}})
  if(found.length!==2||found.some(c=>!c.name.startsWith('QA-SALES-DRAFTS-')))throw Error('Existing QA company targets changed')
  const dir=fs.mkdtempSync(path.join(os.homedir(),'.local','state','auna-role-check-'));fs.chmodSync(dir,0o700)
  const marker=`QA-roles-${randomUUID().slice(0,12)}`,actorId=randomUUID(),targetId=randomUUID(),ledger={marker,actorId,targetId,companies,roleIds:[],retained:true}
  const write=()=>fs.writeFileSync(path.join(dir,'ledger.json'),JSON.stringify(ledger,null,2),{mode:0o600});write()
  const admin=await db.role.findUnique({where:{system_key:'ADMIN'}})
  if(!admin)throw Error('Canonical admin required')
  try {
   await db.$transaction(async tx=>{
    await tx.user.create({data:{id:actorId,name:marker,email:`${actorId}@example.invalid`,password:'not-a-real-login',role_id:admin.id}})
    await tx.userCompany.createMany({data:companies.map(company_id=>({user_id:actorId,company_id,role_id:admin.id}))})
    const legacy=await tx.role.findFirst({where:{id:20,company_id:null}})
    if(!legacy)throw Error('Existing unused legacy alias fixture changed')
    const roleA=await tx.role.create({data:{name:marker,company_id:companies[0],legacy_role_id:legacy.id}}),roleB=await tx.role.create({data:{name:marker,company_id:companies[1]}})
    ledger.roleIds.push(roleA.id,roleB.id);write()
    await tx.user.create({data:{id:targetId,name:marker,email:`${targetId}@example.invalid`,password:'not-a-real-login',role_id:roleB.id}})
    await tx.userCompany.create({data:{user_id:targetId,company_id:companies[0],role_id:admin.id}})
   },{timeout:30000,maxWait:5000})
   await run({db,actorId,targetId,companyA:companies[0],companyB:companies[1],roleA:ledger.roleIds[0],roleB:ledger.roleIds[1],req:{companyId:companies[0],user:{sub:actorId},query:{}},marker,ledger,write})
  }finally{
   // Only these owned IDs, guarded by their marker; never touch original memberships.
   const owned=await db.user.findMany({where:{id:{in:[actorId,targetId]},name:marker},select:{id:true}})
   const ids=owned.map(u=>u.id)
   await db.$transaction(async tx=>{
    await tx.userAccessEvent.deleteMany({where:{actor_id:{in:ids},action:{contains:'rol #'}}})
    await tx.userCompany.deleteMany({where:{user_id:{in:ids}}})
    await tx.user.deleteMany({where:{id:{in:ids},name:marker}})
    await tx.rolePermission.deleteMany({where:{role_id:{in:ledger.roleIds},role:{name:{startsWith:marker}}}})
    await tx.role.deleteMany({where:{id:{in:ledger.roleIds},name:{startsWith:marker}}})
   },{timeout:30000,maxWait:5000})
   ledger.retained=false;write()
  }
 })
}
module.exports={withRolesDevFixture,devDbEnabled}
