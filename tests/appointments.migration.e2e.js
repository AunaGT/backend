const test = require('node:test'), assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { withAppointmentsTestDb } = require('./helpers/appointmentsTestDb.cjs')
test('script de ensayo aplica SQL exacto en esquema aislado y lo retira',async()=>{
  const {appointmentsTestUrl}=require('./helpers/appointmentsTestDb.cjs')
  const {rehearseAppointmentsMigration}=require('../scripts/appointments-staging')
  const result=await rehearseAppointmentsMigration(appointmentsTestUrl())
  assert.match(result.schema,/^appointments_qa_[a-f0-9]{32}$/)
  assert.equal(result.checks.length,3)
})
test('migración aísla FKs y rechaza duración/capacidad inválidas incluso fuera de la API', async () =>
  withAppointmentsTestDb(async ({ db, scope, fixtures, schema }) => {
    const fks = await db.$queryRaw`SELECT n.nspname AS child_schema, p.nspname AS parent_schema
      FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
      JOIN pg_class r ON r.oid=c.confrelid JOIN pg_namespace p ON p.oid=r.relnamespace
      WHERE c.contype='f' AND n.nspname=${schema}`
    assert.ok(fks.length > 20)
    assert.equal(fks.every(row => row.child_schema === schema && row.parent_schema === schema), true)
    const data = { company_id: scope.companyId, product_id: fixtures.productId, mode: 'INDIVIDUAL', duration_minutes: 45, created_by: scope.userId }
    await assert.rejects(() => db.serviceScheduleProfile.create({ data: { ...data, duration_minutes: 0 } }))
    await assert.rejects(() => db.serviceScheduleProfile.create({ data: { ...data, capacity: 2 } }))
    const foreign = await db.company.create({ data: { name: 'Ajena QA', code: crypto.randomUUID().slice(0, 16) } })
    await assert.rejects(() => db.serviceScheduleProfile.create({ data: { ...data, company_id: foreign.id } }))
    assert.equal(await db.serviceScheduleProfile.count(), 0)
  }))
