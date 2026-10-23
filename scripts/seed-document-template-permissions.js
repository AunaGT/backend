require('../src/config/loadEnv')
const {permissions}=require('../src/modules/config/documentTemplates/permissions')
async function seed(db){for(const permission of permissions)await db.permission.upsert({where:{code:permission.code},create:permission,update:{name:permission.name,description:permission.description}})}
if(require.main===module){const {prisma}=require('../src/models/prisma');seed(prisma).then(()=>console.log('Permisos de plantillas registrados; roles existentes conservados.')).catch(e=>{console.error(e.code||'SEED_FAILED');process.exitCode=1}).finally(()=>prisma.$disconnect())}
module.exports={seed}
