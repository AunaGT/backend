const permissions = [
  ['view', 'Ver agenda propia'], ['view_team', 'Ver agenda del equipo'], ['create', 'Crear reservas y sesiones'],
  ['edit', 'Reprogramar reservas y sesiones'], ['cancel', 'Cancelar reservas y sesiones'],
  ['attend', 'Registrar atención y asistencia'], ['configure', 'Configurar agenda y servicios'],
  ['collect','Recibir anticipos y pagos de contrataciones'],['refund','Resolver y devolver anticipos de contrataciones'],['issue_sale','Generar venta de una contratación'],
].map(([suffix, name]) => ({ code: `appointments.${suffix}`, name, description: name }))
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
