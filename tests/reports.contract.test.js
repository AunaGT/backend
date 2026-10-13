const test = require('node:test')
const assert = require('node:assert/strict')
const { resolveReportPeriod, reportDateWhere } = require('../src/modules/reports/reportFilters')
const { createReport, createReportMeta } = require('../src/modules/reports/reportModel')
const now = '2026-10-09T12:00:00Z'
test('report month uses company timezone and exclusive end', () => {
  const p = resolveReportPeriod({ period: 'month', year: '2026', month: '10' }, 'America/Guatemala', now)
  assert.equal(p.start, '2026-10-01T06:00:00.000Z')
  assert.equal(p.endExclusive, '2026-11-01T06:00:00.000Z')
  assert.deepEqual(reportDateWhere({ reportPeriod: p }), { gte: new Date(p.start), lt: new Date(p.endExclusive) })
})
test('all is unbounded and legacy dates stay inclusive', () => {
  const p = resolveReportPeriod({ period: 'all' }, 'America/Guatemala', now)
  assert.equal(p.start, null)
  assert.equal(p.endExclusive, null)
  assert.deepEqual(reportDateWhere({ reportPeriod: p }), {})
  assert.deepEqual(reportDateWhere({}, 1, 2), { gte: 1, lte: 2 })
})
test('DST month and week use local calendar boundaries', () => {
  const p = resolveReportPeriod({ period: 'month', year: '2026', month: '3' }, 'America/New_York', now)
  assert.equal(p.start, '2026-03-01T05:00:00.000Z')
  assert.equal(p.endExclusive, '2026-04-01T04:00:00.000Z')
  const w = resolveReportPeriod({ period: 'week' }, 'America/Guatemala', now)
  assert.equal(w.start, '2026-10-05T06:00:00.000Z')
  assert.equal(w.endExclusive, '2026-10-12T06:00:00.000Z')
})
test('invalid period fields fail validation rather than reaching SQL', () => {
  for (const query of [{ period: 'month', month: 13 }, { period: 'quarter', quarter: 0 }, { period: 'quarter', quarter: 5 },
    { period: 'semester', semester: 3 }, { period: 'year', year: '2026.5' }, { period: 'yesterday' }, { period: 'all', year: ['2026'] }]) {
    assert.throws(() => resolveReportPeriod(query, 'America/Guatemala', now), e => e.status === 400)
  }
  assert.throws(() => resolveReportPeriod({}, 'invalid-zone', now), e => e.status === 400)
})
const column = { id: 'value', label: 'Valor', type: 'money', align: 'right' }
const section = (id, count) => ({ id, title: id, columns: [column], rows: Array.from({ length: count }, () => ({ value: 0 })), totals: null })
const content = sections => ({ id: 'sales', title: 'Ventas', summary: [], sections, charts: [], notes: [] })
test('report preserves zero/null and enforces a total row budget across sections', () => {
  assert.equal(createReport({}, content([section('a', 5000), section('b', 5000)])).sections[1].rows.length, 5000)
  assert.throws(() => createReport({}, content([section('a', 5000), section('b', 5001)])), e => e.status === 422 && e.code === 'REPORT_TOO_LARGE')
  const s = section('a', 2); s.rows[1].value = null
  assert.deepEqual(createReport({}, content([s])).sections[0].rows, [{ value: 0 }, { value: null }])
  for (const value of [NaN, Infinity, -Infinity, {}]) {
    s.rows[0].value = value
    assert.throws(() => createReport({}, content([s])))
  }
})
test('report rejects duplicate IDs and projects only declared values', () => {
  assert.throws(() => createReport({}, content([section('a', 0), section('a', 0)])))
  const s = section('a', 1); s.columns.push(column)
  assert.throws(() => createReport({}, content([s])))
  s.columns.pop(); s.rows[0].secret = 'private'
  assert.deepEqual(createReport({}, content([s])).sections[0].rows[0], { value: 0 })
})
test('metadata excludes storage paths, secrets and unknown branding properties', () => {
  const meta = createReportMeta({ companyId: 'company', user: { name: 'QA', password: 'secret' } },
    { company_name: 'QA', timezone: 'America/Guatemala', currency_code: 'GTQ', key: 'secret', logoBuffer: Buffer.from('invalid') },
    { label: 'Centro', branches: [{ id: 'b', name: 'Centro', private: true }] }, { mode: 'current' }, {}, now)
  assert.equal(meta.branding.logoDataUrl, null)
  assert.deepEqual(meta.scope.branches, [{ id: 'b', name: 'Centro' }])
  assert.ok(!JSON.stringify(meta).includes('secret'))
})
