const permissions=[['view','Consultar puestos y equipos'],['manage','Configurar puestos y equipos'],['test_print','Preparar pruebas de lectura e impresión'],['test_drawer','Probar gaveta en simulación']].map(([suffix,name])=>({code:`hardware.${suffix}`,name,description:name}))
async function seedHardwarePermissions(db){return db.permission.createMany({data:permissions,skipDuplicates:true})}
module.exports={permissions,seedHardwarePermissions}
