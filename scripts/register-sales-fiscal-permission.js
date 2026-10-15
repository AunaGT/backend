// Keep the existing permission identity and grants; only the fiscal action changes.
const permission={code:'sales.fiscal.register',name:'Solicitar facturación electrónica',description:'Solicitar la factura de una venta confirmada; no concede cobros ni certificación manual'}
async function registerSalesFiscalPermission(db){return db.permission.upsert({where:{code:permission.code},create:permission,update:{name:permission.name,description:permission.description}})}
if(require.main===module){
  require('../src/config/loadEnv')
  require('./salesDevTarget').approvedDevTarget(process.env.DIRECT_URL)
  const {PrismaClient}=require('@prisma/client'),db=new PrismaClient({datasources:{db:{url:process.env.DIRECT_URL}}})
  registerSalesFiscalPermission(db).then(()=>console.log('Permiso fiscal registrado; roles y módulos existentes intactos')).catch(error=>{console.error(error.code||'Permission registration failed');process.exitCode=1}).finally(()=>db.$disconnect())
}
module.exports={registerSalesFiscalPermission,permission}
