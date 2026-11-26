require('../src/config/loadEnv')
const {prisma}=require('../src/models/prisma')
const {runIntegrationCleanup}=require('../src/jobs/integrationAuditCleanup')
runIntegrationCleanup({db:prisma}).then(result=>console.log(JSON.stringify(result))).catch(()=>{console.error('No se pudo completar la limpieza de integraciones');process.exitCode=1}).finally(()=>prisma.$disconnect())
