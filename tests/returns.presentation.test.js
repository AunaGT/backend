const test = require('node:test')
const assert = require('node:assert/strict')

const { presentReturnDetail } = require('../src/modules/returns/presentation')

test('detalle expone responsables legibles y conserva el estado fiscal', () => {
  const record = {
    id: 'return-1',
    approved_by: 'user-1',
    processed_by: 'user-2',
    policy_overridden_by: null,
    sale: { sale_dtes: [{ id: 'dte-1', status: 'autorizado', authorization: 'AUTH-1' }] },
  }
  const result = presentReturnDetail(record, [
    { id: 'user-1', name: 'Ana', email: 'ana@example.com' },
    { id: 'user-2', name: 'Luis', email: 'luis@example.com' },
  ])

  assert.equal(result.actors.approved_by.name, 'Ana')
  assert.equal(result.actors.processed_by.name, 'Luis')
  assert.equal(result.actors.policy_overridden_by, null)
  assert.equal(result.fiscal.status, 'PENDING_EXTERNAL_CREDIT_NOTE')
})
