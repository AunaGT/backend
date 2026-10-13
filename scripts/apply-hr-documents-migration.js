// Targeted additive migration for installations with legacy migration history.
// Does not resolve, replay or delete unrelated migrations.
require('../src/config/loadEnv')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { createHash, randomUUID } = require('node:crypto')
const { PrismaClient } = require('@prisma/client')
const name = '20261005120000_hr_employee_documents'
const sql = readFileSync(join(__dirname, '../prisma/migrations', name, 'migration.sql'), 'utf8')
const checksum = createHash('sha256').update(sql).digest('hex')
const db = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL || process.env.DATABASE_URL } } })

async function main() {
  await db.$transaction(async tx => {
    await tx.$executeRawUnsafe('SET LOCAL lock_timeout = \'5s\'')
    await tx.$queryRawUnsafe('SELECT pg_advisory_xact_lock(20261005, 120000)::text')
    const prior = await tx.$queryRaw`SELECT checksum, finished_at FROM "_prisma_migrations" WHERE migration_name = ${name} AND rolled_back_at IS NULL`
    if (prior.length) {
      if (prior.length !== 1 || prior[0].checksum !== checksum || !prior[0].finished_at) throw new Error('La migración de RRHH registrada requiere revisión manual')
      console.log('Migración de RRHH ya aplicada; no se modificó nada')
      return
    }
    const conflict = await tx.$queryRaw`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND (table_name IN ('employee_document_types', 'employee_documents', 'employee_history') OR (table_name = 'employees' AND column_name IN ('gender', 'marital_status', 'nationality', 'workday', 'work_schedule', 'supervisor_id', 'photo_storage_path', 'creation_request_id', 'creation_request_hash')))`
    if (conflict.length) throw new Error('Hay cambios parciales de RRHH; no se aplicará SQL automáticamente')
    const before = await tx.employee.count()
    // This reviewed migration has no procedural blocks or embedded semicolons.
    for (const statement of sql.split(';').map(s => s.trim()).filter(Boolean)) await tx.$executeRawUnsafe(statement)
    const after = await tx.employee.count()
    if (before !== after) throw new Error('El recuento de empleados cambió; se revierte la operación')
    await tx.$executeRaw`INSERT INTO "_prisma_migrations" (id, checksum, finished_at, migration_name, started_at, applied_steps_count) VALUES (${randomUUID()}, ${checksum}, NOW(), ${name}, NOW(), 1)`
    console.log(`Migración exclusiva de RRHH aplicada. Empleados conservados: ${after}`)
  }, { maxWait: 10000, timeout: 30000 })
}
main().catch(error => { console.error(error.code || error.message); process.exitCode = 1 }).finally(() => db.$disconnect())
