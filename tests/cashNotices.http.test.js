const test = require('node:test'), assert = require('node:assert/strict'), { randomUUID } = require('node:crypto')
const { withMocks, jsonResponse } = require('./helpers/reportHarness.cjs')
const companyId = randomUUID(), branchId = randomUUID(), userId = randomUUID(), id = randomUUID()
const request = (permissions, body = {}) => ({ companyId, branchId, user: { sub: userId, name: 'QA', role: { name: 'Encargado' }, permissions }, body, query: {}, params: { noticeId: id } })
async function call(api, action, req) { const res = jsonResponse(); const headers = {}; res.set = (k, v) => { headers[k] = v; return res }; let error; await api[action](req, res, e => error = e); return { res, error, headers } }
const paths = () => ({ service: require.resolve('../src/modules/cash-closure/notices'), evidence: require.resolve('../src/modules/cash-closure/noticeEvidence'),
  controller: require.resolve('../src/modules/cash-closure/notices.controller'), prisma: require.resolve('../src/models/prisma') })

test('notice HTTP adapters keep their own gates, never cache and replay idempotently', async () => {
  const { service, evidence, controller, prisma } = paths(), db = { $transaction: fn => fn(db) }
  const calls = []
  await withMocks({ [prisma]: { prisma: db }, [evidence]: { evidenceAvailable: async () => true },
    [service]: { noticesAvailable: async () => true, createNotice: async (_, s, input) => { calls.push(['create', s.userId]); return { replayed: input.replay === true, notice: { id } } },
      confirmNotice: async (_, s, noticeId) => { calls.push(['confirm', noticeId]); return { replayed: false, notice: { id, status: 'CONFIRMED' } } } } }, controller, async api => {
    for (const permissions of [[], ['sales.create'], ['receivables.manage'], ['cashclosure.approve'], ['cash.digital.confirm']])
      assert.equal((await call(api, 'create', request(permissions))).error.status, 403, String(permissions))
    for (const permissions of [[], ['cash.notices.create'], ['cash.digital.confirm'], ['receivables.manage'], ['cash.notices.create', 'receivables.manage']])
      assert.equal((await call(api, 'confirm', request(permissions))).error.status, 403, String(permissions))
    const fresh = await call(api, 'create', request(['cash.notices.create']))
    assert.equal(fresh.res.statusCode, 201); assert.equal(fresh.headers['Cache-Control'], 'private, no-store')
    assert.equal((await call(api, 'create', request(['cash.notices.create'], { replay: true }))).res.statusCode, 200)
    assert.equal((await call(api, 'confirm', request(['cash.digital.confirm', 'receivables.manage']))).res.statusCode, 201)
    assert.equal((await call(api, 'capabilities', request(['cash.notices.create']))).res.body.evidenceUpload, false, 'only confirmers upload evidence')
    assert.deepEqual(calls, [['create', userId], ['create', userId], ['confirm', id]])
  })
})

test('evidence is validated by content and never signed for another company', async () => {
  const { signEvidence, uploadEvidence } = require('../src/modules/cash-closure/noticeEvidence')
  const fake = { buffer: Buffer.from('<html>no soy pdf</html>'), size: 23, originalname: 'deposito.pdf', mimetype: 'application/pdf' }
  await assert.rejects(uploadEvidence(companyId, fake), e => e.status === 400)
  await assert.rejects(signEvidence(companyId, `${randomUUID()}/notices/${randomUUID()}.pdf`), e => e.status === 404)
  await assert.rejects(signEvidence(companyId, null), e => e.status === 404)
})

test('without the notices schema or a private bucket the capabilities say so', async () => {
  const { service, evidence, controller, prisma } = paths()
  await withMocks({ [prisma]: { prisma: {} }, [service]: { noticesAvailable: async () => false }, [evidence]: { evidenceAvailable: async () => false } }, controller, async api => {
    const { res } = await call(api, 'capabilities', request(['cash.digital.confirm', 'receivables.manage']))
    assert.deepEqual(res.body, { available: false, canView: true, canCreate: false, canConfirm: true, evidenceUpload: false })
  })
})
