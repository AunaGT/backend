const { PrismaClient } = require('@prisma/client')

function servicesTestDatabaseUrl(env = process.env) {
  if (env.AUNA_SERVICES_STAGING_TESTS === 'approved') {
    if (!env.DIRECT_URL) throw new Error('Falta la conexión directa de staging autorizada')
    const staging = new URL(env.DIRECT_URL)
    if (!['postgresql:', 'postgres:'].includes(staging.protocol) || staging.hostname !== 'aws-1-us-east-2.pooler.supabase.com' || staging.port !== '5432' || staging.pathname !== '/postgres') throw new Error('Destino de staging no autorizado')
    for (const key of [...staging.searchParams.keys()]) {
      if (!['sslmode', 'connect_timeout', 'pgbouncer', 'connection_limit', 'pool_timeout', 'schema'].includes(key)) throw new Error('Opciones de conexión no autorizadas')
      if (!['sslmode', 'connect_timeout'].includes(key)) staging.searchParams.delete(key)
    }
    staging.searchParams.set('connect_timeout', '10')
    return staging.toString()
  }
  const raw = env.AUNA_SERVICES_TEST_DATABASE_URL
  if (!raw) throw new Error('Autoriza y configura exclusivamente una base temporal local de Servicios')
  const url = new URL(raw)
  if (!['postgresql:', 'postgres:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.pathname !== '/auna_services_test' || url.search) {
    throw new Error('Las pruebas de Servicios solo admiten la base temporal local auna_services_test sin opciones de conexión')
  }
  return raw
}

function openServicesTestDb() {
  return new PrismaClient({ datasources: { db: { url: servicesTestDatabaseUrl() } } })
}

module.exports = { servicesTestDatabaseUrl, openServicesTestDb }
