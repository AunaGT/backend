// Targeted catalog registration only: never grants permissions or runs the global seed.
require('../src/config/loadEnv')
const { PrismaClient } = require('@prisma/client')
const db = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL || process.env.DATABASE_URL } } })
const permissions = [
  { code: 'hr.documents.view', name: 'Ver documentos de empleados', description: 'Puede abrir y descargar documentos privados del expediente' },
  { code: 'hr.documents.manage', name: 'Gestionar documentos de empleados', description: 'Puede cargar y reemplazar documentos del expediente' },
  { code: 'hr.documents.archive', name: 'Archivar documentos de empleados', description: 'Puede archivar y restaurar versiones del expediente' },
]
async function main() {
  await db.$transaction(permissions.map(permission => db.permission.upsert({ where: { code: permission.code }, create: permission, update: {} })))
  const count = await db.permission.count({ where: { code: { in: permissions.map(permission => permission.code) } } })
  if (count !== 3) throw new Error('No se pudo verificar el catálogo documental')
  console.log('Catálogo RRHH: 3 permisos registrados; no se modificaron roles ni concesiones')
}
main().catch(error => { console.error(error.message); process.exitCode = 1 }).finally(() => db.$disconnect())
