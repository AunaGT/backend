const test = require('node:test'), assert = require('node:assert/strict'), { randomUUID } = require('node:crypto')
const companyId = randomUUID(), branchId = randomUUID(), userId = randomUUID()
const admin = { id: 1, name: 'admin', system_key: 'ADMIN', company_id: null }
const req = (permissions = [], role = { name: 'Contador' }) => ({ companyId, branchId, user: { sub: userId, role, permissions } })
test('an older client reports a linked-dispute database guard as a recoverable settlement conflict',async()=>{
  let reads=0
  const db={$queryRaw:async()=>++reads===1?[{ok:true}]:[{id:randomUUID(),status:'POSTED'}],$executeRaw:async()=>{throw Object.assign(new Error('dispute_settlement_dependency'),{code:'P2010'})}}
  await assert.rejects(require('../src/modules/cash-closure/settlements').voidSettlement(db,{companyId,branchId,userId},randomUUID(),{reason:'Intento antiguo'}),error=>error.status===409&&error.code==='CASH_SETTLEMENT_DISPUTE_DEPENDENCY')
})

test('bank methods and settlements each need their own authority', () => {
  const { settlementScope } = require('../src/modules/cash-closure/settlements.access')
  for (const permissions of [[], ['sales.create'], ['settings.manage'], ['receivables.manage'], ['cash.digital.confirm'], ['accounting.manage']])
    for (const action of ['methods', 'settlements']) assert.throws(() => settlementScope(req(permissions), action), e => e.status === 403, `${permissions} ${action}`)
  const manager = settlementScope(req(['cash.bank_methods.manage']), 'methods')
  assert.equal(manager.canManage, true); assert.equal(manager.isAdmin, false, 'a manager prepares but never approves')
  assert.equal(settlementScope(req(['cash.settlements.manage']), 'settlements').canSettle, true)
  assert.throws(() => settlementScope({ companyId, branchId, integrationCredential: { id: 'k' } }, 'settlements'), e => e.status === 401)
  assert.equal(settlementScope(req([], admin), 'methods').isAdmin, true)
})

test('4B permissions are registered only for the canonical admin and listed in the catalog', async () => {
  const { registerCashNoticePermissionsForAdmin, registerCashSettlementPermissionsForAdmin } = require('../scripts/register-cash-permissions')
  const rows = [{ id: 1, code: 'sales.create' }], grants = [{ role_id: 112, permission_id: 1 }, { role_id: 139, permission_id: 1 }]
  const db = { role: { findUnique: async () => admin }, permission: { upsert: async ({ create }) => {
    let row = rows.find(r => r.code === create.code); if (!row) rows.push(row = { id: rows.length + 1, ...create }); return row
  } }, rolePermission: { createMany: async ({ data }) => { for (const g of data) if (!grants.some(r => r.role_id === g.role_id && r.permission_id === g.permission_id)) grants.push(g) } } }
  db.$transaction = fn => fn(db)
  await registerCashNoticePermissionsForAdmin(db); const before = grants.length
  await registerCashSettlementPermissionsForAdmin(db); await registerCashSettlementPermissionsForAdmin(db)
  assert.deepEqual(rows.slice(-2).map(r => r.code), ['cash.bank_methods.manage', 'cash.settlements.manage']); assert.equal(grants.length, before + 2)
  assert.deepEqual(grants.filter(g => g.role_id !== 1), [{ role_id: 112, permission_id: 1 }, { role_id: 139, permission_id: 1 }])
  const { permissions } = require('../src/config/permissionCatalog')
  for (const code of ['cash.bank_methods.manage', 'cash.settlements.manage']) assert.ok(permissions.some(p => p.code === code), code)
})

test('posting builders use the frozen bank account of the money event and keep the old rule otherwise', () => {
  const { buildSalePosting, buildReturnPosting } = require('../src/services/accounting/postingEngine')
  const { buildEngagementPosting } = require('../src/services/accounting/engagementPosting')
  const defaults = Object.fromEntries(['salesReturns', 'sales', 'cash', 'bank', 'receivables', 'inventory', 'cogs', 'pequenoTax', 'pequenoTaxExpense', 'ivaDebit'].map(id => [id, { id }]))
  const options = { defaults, splitVat: false, ivaRate: 0, costBase: c => c, pequenoTaxOf: () => 0 }
  const card = { name: 'Tarjeta', settlement_kind: 'BANK', is_credit: false }
  const sale = extra => ({ total: '100', payment_method: card, sale_items: [], ...extra })
  assert.equal(buildSalePosting(sale({ frozenBankAccountId: 1105 }), options)[0].account_id, 1105, 'deferred card debits the clearing account')
  assert.equal(buildSalePosting(sale(), options)[0].account_id, 'bank', 'a historical sale keeps going to bank')
  assert.equal(buildSalePosting(sale({ payment_method: { name: 'Efectivo', settlement_kind: 'CASH' }, frozenBankAccountId: 1105 }), options)[0].account_id, 'cash', 'cash never uses a bank classification')
  const ret = { total_refund: '30', type: 'RETURN', sale: { payment_method: card }, return_items: [], settlements: [{ kind: 'REFUND', amount: '30', payment_method: card, frozenBankAccountId: 1105 }] }
  assert.deepEqual(buildReturnPosting(ret, options).find(l => l.credit > 0), { account_id: 1105, debit: 0, credit: 30 })
  const accounts = { cash: 'cash', bank: 'bank', customerAdvances: 'adv', receivables: 'rec' }
  assert.equal(buildEngagementPosting({ kind: 'RECEIVE', amount: '50', isCash: false, frozenBankAccountId: 1102 }, accounts)[0].account_id, 1102)
  assert.equal(buildEngagementPosting({ kind: 'REFUND', amount: '50', isCash: false }, accounts)[1].account_id, 'bank')
})
