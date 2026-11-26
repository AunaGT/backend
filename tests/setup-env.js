/**
 * Entorno aislado para pruebas unitarias.
 *
 * Nunca debe cargar las credenciales de desarrollo o producción: los unit tests
 * usan dobles de prueba y deben fallar antes que conectarse a servicios remotos.
 */

process.env.NODE_ENV = 'test'
process.env.ENV_FILE = '/dev/null'
process.env.JWT_SECRET = 'auna-unit-tests-only-secret-never-use-in-production'

for (const key of [
  'DATABASE_URL',
  'DIRECT_URL',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
]) {
  delete process.env[key]
}

// Prisma can independently load .env when its client is constructed.
// Unit tests must provide a database double instead of constructing that client.
const database = new Proxy({}, { get() { throw Error('A unit test attempted to use the database without a test double') } })
const databaseModule = require.resolve('../src/models/prisma')
require.cache[databaseModule] = { id: databaseModule, filename: databaseModule, loaded: true, exports: { prisma: database, prismaTransaction: database } }
