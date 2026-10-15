const test = require('node:test')
const assert = require('node:assert/strict')
const { withMocks, jsonResponse } = require('./helpers/reportHarness.cjs')
const target = require.resolve('../src/modules/config/controller')
const model = require.resolve('../src/models/prisma')

test('cuerpos malformados no escriben ni abren transacción', async t => {
  let touches = 0
  const touch = async () => { touches++; return [] }
  const db = { systemSetting: { upsert: touch, findMany: touch }, $transaction: touch }
  await withMocks({ [model]: { prisma: db, prismaTransaction: db } }, target, async controller => {
    for (const [label, body] of [
      ['ausente', undefined], ['null', null], ['array', []],
      ['settings array', { settings: [] }], ['settings null', { settings: null }],
    ]) {
      await t.test(label, async () => {
        const res = jsonResponse()
        let forwarded
        await controller.update({ companyId: 'A', body }, res, error => { forwarded = error })
        assert.equal(forwarded, undefined)
        assert.equal(res.statusCode, 400)
      })
    }
  })
  assert.equal(touches, 0)
})

test('vigencias inválidas se rechazan completas antes de persistir', async t => {
  let touches = 0
  const touch = async () => { touches++; return [] }
  const db = { systemSetting: { upsert: touch, findMany: touch }, $transaction: touch }
  await withMocks({ [model]: { prisma: db, prismaTransaction: db } }, target, async controller => {
    for (const key of ['quote_validity_days', 'order_validity_days', 'quote_soft_hold_hours']) {
      for (const value of [0, -1, 1.5, '7days', '', Infinity, Number.MAX_SAFE_INTEGER + 1, true, [5], {}]) {
        await t.test(`${key}=${JSON.stringify(value)}`, async () => {
          const res = jsonResponse()
          await controller.update({ companyId: 'A', body: { [key]: value } }, res,
            error => { throw error })
          assert.equal(res.statusCode, 400)
        })
      }
    }
  })
  assert.equal(touches, 0)
})

test('vigencias aceptadas se guardan como enteros canónicos', async () => {
  const rows = new Map()
  const db = { systemSetting: {
    upsert: async ({ create }) => { rows.set(create.key, create) },
    findMany: async () => [...rows.values()],
  } }
  db.$transaction = async run => run(db)
  await withMocks({ [model]: { prisma: db, prismaTransaction: db } }, target, async controller => {
    for (const [input, expected] of [[12, '12'], ['12', '12'], ['1e2', '100']]) {
      const res = jsonResponse()
      await controller.update({ companyId: 'A', body: { order_validity_days: input } }, res,
        error => { throw error })
      assert.equal(res.statusCode, 200)
      assert.equal(res.body.order_validity_days, expected)
    }
  })
})
