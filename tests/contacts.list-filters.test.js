const test = require('node:test')
const assert = require('node:assert/strict')
const { withMocks, jsonResponse } = require('./helpers/reportHarness.cjs')
const path = require('node:path')

async function list(query, permissions, check) {
  const reads = []
  const supplier = {
    count: async args => { reads.push(args); return 25 },
    groupBy: async args => { reads.push(args); return [{ estado: 0, _count: { _all: 25 } }] },
    findMany: async args => { reads.push(args); return [] },
  }
  return withMocks({
    [require.resolve('../src/models/prisma')]: { prisma: { supplier } },
    [require.resolve('../src/utils/getTimezone')]: { getTimezone: async () => 'America/Guatemala' },
    [require.resolve('../src/modules/contacts/imageStorage')]: { contactImageDtos: async rows => rows },
  }, path.resolve(__dirname, '../src/modules/contacts/controller.js'), async controller => {
    const response = jsonResponse()
    await controller.list({ companyId: 'company-qa', user: { permissions }, query }, response, error => { throw error })
    check(response, reads)
  })
}
test('contact filters are applied before pagination and summary without escaping tenant/type permissions', async () => {
  await list({ estado: '0', search: '5555', category_id: '4', page: '2', pageSize: '10', includeSummary: 'true' }, ['contacts.suppliers.view'], (response, reads) => {
    assert.equal(response.statusCode, 200)
    const where = reads[0].where
    assert.equal(where.company_id, 'company-qa')
    assert.equal(where.deleted, false)
    assert.deepEqual(where.party_type, { in: ['SUPPLIER'] })
    assert.equal(where.estado, 0)
    assert.deepEqual(where.categories, { some: { category_id: 4 } })
    assert.ok(where.OR.some(condition => condition.phone?.contains === '5555'))
    assert.ok(where.OR.some(condition => condition.tax_id?.contains === '5555'))
    assert.deepEqual(reads[1].where, where)
    assert.deepEqual(reads[2].where, where)
    assert.equal(reads[2].take, 10)
    assert.equal(reads[2].skip, 10)
    assert.deepEqual(response.body.summary, { total: 25, active: 0, inactive: 25 })
  })
})
test('contact state filter validates unknown values before touching the database', async () => {
  for (const estado of ['2', '-1', 'active', '', ['0', '1']]) await list({ estado }, ['contacts.clients.view'], (response, reads) => {
    assert.equal(response.statusCode, 400)
    assert.equal(reads.length, 0)
  })
})
test('unauthorized party selection is rejected even with valid contact filters', async () => {
  await list({ party_type: 'SUPPLIER', estado: '1' }, ['contacts.clients.view'], (response, reads) => {
    assert.equal(response.statusCode, 403)
    assert.equal(reads.length, 0)
  })
  await list({ estado: '1' }, ['contacts.clients.view'], (response, reads) => {
    assert.equal(response.statusCode, 200)
    assert.equal(reads[0].where.estado, 1)
    assert.deepEqual(reads[0].where.party_type, { in: ['CUSTOMER'] })
    assert.equal(reads.length, 2)
  })
})
