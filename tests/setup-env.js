/**
 * Entorno aislado para pruebas unitarias.
 *
 * Nunca debe cargar las credenciales de desarrollo o producción: los unit tests
 * usan dobles de prueba y deben fallar antes que conectarse a servicios remotos.
 */

process.env.NODE_ENV = 'test'
process.env.JWT_SECRET = 'auna-unit-tests-only-secret-never-use-in-production'

for (const key of [
  'DATABASE_URL',
  'DIRECT_URL',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
]) {
  delete process.env[key]
}
