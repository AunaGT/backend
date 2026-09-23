const test = require('node:test')
const assert = require('node:assert/strict')

test('combina alcance tenant, dirección y filtros del listado', () => {
  const { buildTransferWhere } = require('../src/modules/transfers/domain')

  assert.deepEqual(buildTransferWhere({
    companyId: 'company-1',
    branchId: 'branch-1',
    direction: 'in',
    status: 'RECIBIDA',
    search: 'TR-25',
    fromBranchId: 'branch-2',
    toBranchId: 'branch-1',
  }), {
    AND: [
      { to_branch_id: 'branch-1' },
      { from_branch_id: 'branch-2' },
      { to_branch_id: 'branch-1' },
      { status: 'RECIBIDA' },
      { OR: [
        { reference: { contains: 'TR-25', mode: 'insensitive' } },
        { fromBranch: { name: { contains: 'TR-25', mode: 'insensitive' } } },
        { toBranch: { name: { contains: 'TR-25', mode: 'insensitive' } } },
        { lines: { some: { product: { name: { contains: 'TR-25', mode: 'insensitive' } } } } },
      ] },
      { fromBranch: { company_id: 'company-1' } },
    ],
  })
})

test('rechaza dirección y estado desconocidos', () => {
  const { buildTransferWhere } = require('../src/modules/transfers/domain')

  assert.throws(() => buildTransferWhere({ companyId: 'c', direction: 'sideways' }), /dirección/i)
  assert.throws(() => buildTransferWhere({ companyId: 'c', status: 'BORRADOR' }), /estado/i)
})
