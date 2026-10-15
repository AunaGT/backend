const test = require('node:test')
const assert = require('node:assert/strict')
const { withMocks } = require('./helpers/reportHarness.cjs')
const target = require.resolve('../src/services/commercialDocumentSettings')
const model = require.resolve('../src/models/prisma')

test('sin empresa no consulta preferencias comerciales', async () => {
  let reads = 0
  const db = { systemSetting: { findMany: async () => { reads++; return [] } } }
  await withMocks({ [model]: { prisma: db } }, target, async service => {
    for (const name of ['getCommercialDocSettings', 'defaultOrderValidUntil',
      'defaultQuoteValidUntil', 'defaultQuoteSoftHoldExpiresAt']) {
      for (const companyId of [undefined, null, '', '   ']) {
        await assert.rejects(service[name](db, companyId), error => error.status === 403)
      }
    }
  })
  assert.equal(reads, 0)
})

test('separa empresas y no hereda valores de otra cuando faltan', async () => {
  const seen = []
  const days = { A: '3', B: '17' }
  const db = { systemSetting: { findMany: async ({ where }) => {
    seen.push(where.company_id)
    return days[where.company_id]
      ? [{ key: 'order_validity_days', value: days[where.company_id] }]
      : []
  } } }
  await withMocks({ [model]: { prisma: db } }, target, async service => {
    assert.equal((await service.getCommercialDocSettings(db, 'A')).orderValidityDays, 3)
    assert.equal((await service.getCommercialDocSettings(db, 'B')).orderValidityDays, 17)
    assert.deepEqual(await service.getCommercialDocSettings(db, 'C'), {
      quoteValidityDays: 30, orderValidityDays: 7, quoteSoftHoldHours: 48,
    })
    const before = new Date()
    before.setDate(before.getDate() + 17)
    const result = await service.defaultOrderValidUntil(db, 'B')
    const after = new Date()
    after.setDate(after.getDate() + 17)
    assert.ok(result >= before && result <= after)
  })
  assert.deepEqual(seen, ['A', 'B', 'C', 'B'])
})
