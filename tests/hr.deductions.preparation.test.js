const test = require('node:test')
const assert = require('node:assert/strict')
const { withMocks } = require('./helpers/reportHarness.cjs')
const path = require('node:path')
const target = path.resolve(__dirname, '../src/services/payroll/prepareDeductions.js')

function fixture(map = {}, occupied = null) {
  const state = { map: { ...map }, account: occupied, writes: 0, creates: 0 }
  const db = {
    $queryRaw: async () => [],
    $executeRaw: async () => 1,
    systemSetting: { findUnique: async () => ({ value: JSON.stringify(state.map), revision: 7 }) },
    account: {
      findFirst: async ({ where }) => where.code === '2' ? { id: 'parent', type: 'LIABILITY', is_group: true } : state.account,
      create: async ({ data }) => { state.creates++; return (state.account = { id: 'account', active: true, ...data }) },
    },
  }
  const settings = {
    setSettingsActor: async () => {},
    writeSettings: async (_tx, input) => {
      assert.equal(input.expectedRevisions['accounting.defaultAccounts'], 7)
      state.writes++; state.map = JSON.parse(input.changes['accounting.defaultAccounts'].value)
    },
  }
  return { state, db, settings }
}
const run = (f, fn) => withMocks({ [require.resolve('../src/services/settingsRevision')]: f.settings }, target, api => fn(api, f))

test('preparation adds only deductions mapping and is idempotent', async () => {
  const f = fixture({ cash: 'custom-cash' })
  await run(f, async ({ prepareDeductions }) => {
    assert.deepEqual(await prepareDeductions(f.db, 'company', null), { configured: true, conflict: null })
    assert.deepEqual(f.state.map, { cash: 'custom-cash', payrollOtherDeductions: '2108' })
    await prepareDeductions(f.db, 'company', null)
    assert.equal(f.state.creates, 1); assert.equal(f.state.writes, 1)
  })
})
test('preparation preserves a remapped account without writing or creating', async () => {
  const f = fixture({ payrollOtherDeductions: 'custom' }, { id: 'existing', active: true, is_group: false, type: 'LIABILITY' })
  await run(f, async ({ prepareDeductions }) => {
    assert.equal((await prepareDeductions(f.db, 'company', null)).configured, true)
    assert.equal(f.state.writes + f.state.creates, 0)
  })
})
test('preparation reports a code collision without overwriting accounts', async () => {
  const f = fixture({}, { id: 'other', name: 'Otro pasivo', active: true, is_group: false, type: 'LIABILITY' })
  await run(f, async ({ prepareDeductions }) => {
    const result = await prepareDeductions(f.db, 'company', null)
    assert.equal(result.configured, false); assert.match(result.conflict, /2108/)
    assert.equal(f.state.writes + f.state.creates, 0)
  })
})
