const { registerPermissionsForAdmin } = require('../src/config/permissionCatalog')

if (require.main === module) {
  if (process.argv.slice(2).join(' ') !== '--apply') {
    console.log('Usa --apply únicamente con el destino de desarrollo aprobado. Registra el catálogo y concede permisos solo al admin global protegido.')
    process.exitCode = 1
  } else {
    require('../src/config/loadEnv')
    let db
    Promise.resolve().then(async () => {
      const url = process.env.DIRECT_URL || process.env.DATABASE_URL
      require('./salesDevTarget').approvedDevTarget(url)
      const { PrismaClient } = require('@prisma/client')
      db = new PrismaClient({ datasources: { db: { url } } })
      const result = await registerPermissionsForAdmin(db)
      console.log(`Catálogo registrado: ${result.permissions} permisos. Concesiones sincronizadas solo para el admin global protegido.`)
    }).catch(() => {
      console.error('No se registraron los permisos. Revisa el destino de desarrollo aprobado y la existencia del admin global canónico.')
      process.exitCode = 1
    }).finally(() => db?.$disconnect())
  }
}

module.exports = { registerPermissionsForAdmin }
