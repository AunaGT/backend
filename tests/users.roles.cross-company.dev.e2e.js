require('../src/config/loadEnv')
const test=require('node:test'),assert=require('node:assert/strict')
const {withRolesDevFixture,devDbEnabled}=require('./helpers/rolesDevFixture.cjs')
test('Supabase: concurrent cross-company reassignments serialize before membership writes',{skip:!devDbEnabled},async()=>withRolesDevFixture(async f=>{
 const admin=await f.db.role.findUnique({where:{system_key:'ADMIN'}})
 await f.db.user.update({where:{id:f.targetId},data:{role_id:admin.id}})
 await f.db.userCompany.update({where:{user_id_company_id:{user_id:f.targetId,company_id:f.companyA}},data:{role_id:null}})
 await f.db.userCompany.create({data:{user_id:f.targetId,company_id:f.companyB,role_id:null}})
 let arrivals=0,release;const barrier=new Promise(r=>release=r)
 const timer=setTimeout(()=>release(),10000)
 const transactionDb={...f.db,$transaction:async(run,options)=>f.db.$transaction(async tx=>{
  let first=true
  const instrumented=new Proxy(tx,{get(target,key){
   if(key!=='$queryRaw')return Reflect.get(target,key)
   return async(...args)=>{
    const sql=args[0].join(' ')
    if(first&&/FROM users\b/.test(sql)&&/FOR UPDATE/.test(sql)) {first=false;if(++arrivals===2)release();await barrier}
    return Reflect.apply(target.$queryRaw,target,args)
   }
  }})
  return run(instrumented)
 },{...options,timeout:30000,maxWait:5000})}
 const model=require.resolve('../src/models/prisma'),controllerPath=require.resolve('../src/modules/users/adminController'),oldModel=require.cache[model],oldController=require.cache[controllerPath]
 require.cache[model]={exports:{prisma:f.db,prismaTransaction:transactionDb}};delete require.cache[controllerPath]
 try {
  const controller=require(controllerPath)
  async function update(companyId,role_id) {
   let error,result
   await controller.update({companyId,params:{id:f.targetId},user:{sub:f.actorId},body:{role_id}}, {json:value=>result=value},e=>error=e)
   if(error)throw error
   return result
  }
  const results=await Promise.allSettled([update(f.companyA,f.roleA),update(f.companyB,f.roleB)])
  assert.deepEqual(results.map(r=>r.status),['fulfilled','fulfilled'],results.filter(r=>r.status==='rejected').map(r=>r.reason.message).join(';'))
  const members=await f.db.userCompany.findMany({where:{user_id:f.targetId},orderBy:{company_id:'asc'}})
  assert.equal(members.find(m=>m.company_id===f.companyA).role_id,f.roleA)
  assert.equal(members.find(m=>m.company_id===f.companyB).role_id,f.roleB)
 }finally {
  clearTimeout(timer);if(oldModel)require.cache[model]=oldModel;else delete require.cache[model]
  if(oldController)require.cache[controllerPath]=oldController;else delete require.cache[controllerPath]
 }
}))
