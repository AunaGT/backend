const test = require('node:test')
const assert = require('node:assert/strict')
const { withMocks, jsonResponse } = require('./helpers/reportHarness.cjs')
const target = require.resolve('../src/modules/config/controller')
const prismaId = require.resolve('../src/models/prisma')

test('services are disabled by default and public settings are scoped to the requesting company', async () => {
  const seen = []
  const prisma = { systemSetting: { findMany: async ({ where }) => {
    seen.push(where)
    return where.company_id === 'B' ? [{ key: 'inventory_services_enabled', value: 'true' }] : []
  } } }
  await withMocks({ [prismaId]: { prisma } }, target, async controller => {
    for (const [companyId, want] of [['A', 'false'], ['B', 'true']]) {
      const res = jsonResponse()
      await controller.getPublic({ companyId }, res, error => { throw error })
      assert.equal(res.body.inventory_services_enabled, want)
    }
  })
  assert.deepEqual(seen.map(query => query.company_id), ['A', 'B'])
  assert.ok(seen.every(query => query.key.in.includes('inventory_services_enabled')))
})

test('invalid service flag is rejected before any settings write', async () => {
  let writes = 0
  const prisma = { systemSetting: { upsert: async () => { writes++ }, findMany: async () => [] } }
  await withMocks({ [prismaId]: { prisma } }, target, async controller => {
    const res = jsonResponse()
    await controller.update({ companyId: 'A', body: { inventory_services_enabled: 'maybe' } }, res, error => { throw error })
    assert.equal(res.statusCode, 400)
    assert.equal(writes, 0)
  })
})
