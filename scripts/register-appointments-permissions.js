const { permissions } = require('../src/modules/appointments/permissions')
async function registerAppointmentsPermissions(db) {
  return db.permission.createMany({ data: permissions, skipDuplicates: true })
}
if (require.main === module) {
  require('../src/config/loadEnv')
  const { PrismaClient } = require('@prisma/client')
  const db = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL || process.env.DATABASE_URL } } })
  registerAppointmentsPermissions(db)
    .then(() => console.log('Catálogo Agenda registrado; no se modificaron roles ni concesiones'))
    .catch(error => { console.error(error.message); process.exitCode = 1 })
    .finally(() => db.$disconnect())
}
module.exports = { permissions, registerAppointmentsPermissions }
