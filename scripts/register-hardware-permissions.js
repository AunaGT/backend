const {seedHardwarePermissions}=require('../src/modules/config/hardware/seed')
if(require.main===module){
  require('../src/config/loadEnv')
  const {PrismaClient}=require('@prisma/client'),db=new PrismaClient({datasources:{db:{url:process.env.DIRECT_URL||process.env.DATABASE_URL}}})
  seedHardwarePermissions(db).then(()=>console.log('Catálogo de hardware registrado; no se modificaron roles ni concesiones')).catch(()=>{console.error('No se pudo registrar el catálogo de hardware');process.exitCode=1}).finally(()=>db.$disconnect())
}
module.exports={seedHardwarePermissions}
