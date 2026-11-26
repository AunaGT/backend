const test = require('node:test')
const assert = require('node:assert/strict')
const { withMocks, jsonResponse } = require('./helpers/reportHarness.cjs')

async function changeSale({ permissions = ['sales.cancel'], branchId = 'B', saleBranch = 'B' } = {}) {
  const current = { id: 'S', reference: 'V-1', branch_id: saleBranch, created_by: 'U', status_id: 1, status: { name: 'Completada' }, settlement_source: 'POS', sale_items: [], cashRegisterSession: { status: 'OPEN' }, paymentEntries: [], orderLink: null }
  const writes = [], locks = []
  const db = {
    $queryRaw: async (query, ...values) => { locks.push(values); return [{ id: 'S' }] },
    saleStatus: { findFirst: async () => ({ id: 2, name: 'Cancelada' }), findUnique: async () => ({ id: 2, name: 'Cancelada' }) },
    sale: { findFirst: async () => current, update: async args => { writes.push(args); return { ...current, ...args.data } } },
    $transaction: async fn => fn(db),
  }
  const req = { params: { id: 'S' }, body: { status_name: 'Cancelada' }, companyId: 'A', branchId, userBranchIds: ['B'], user: { sub: 'U', permissions } }
  const res = jsonResponse(); let error
  await withMocks({
    [require.resolve('../src/models/prisma')]: { prisma: db, prismaTransaction: db },
    [require.resolve('../src/services/units/commercialPhysical')]: { cancelSalePhysical: async () => { writes.push('physical'); return [] } },
    [require.resolve('../src/services/stockAlerts')]: { ensureStockAlertsBatch: async () => {} },
  }, require.resolve('../src/modules/sales/controller'), controller => controller.updateStatus(req, res, e => { error = e }))
  return { res, error, writes, locks }
}

test('sale cancellation rejects a creator even when called outside the router', async () => {
  const result = await changeSale({ permissions: ['sales.create'] })
  assert.equal(result.error?.status || result.res.statusCode, 403)
  assert.deepEqual(result.writes, [])
})
test('sale mutations reject another branch and consolidated scope before any physical effect', async () => {
  for (const scope of [{ saleBranch: 'OTHER' }, { branchId: null }]) {
    const result = await changeSale(scope)
    assert.ok([400, 403, 404].includes(result.error?.status || result.res.statusCode))
    assert.deepEqual(result.writes, [])
  }
})
test('an authorized cancellation locks and modifies only the active branch', async () => {
  const result = await changeSale()
  assert.equal(result.error, undefined)
  assert.equal(result.res.statusCode, 200)
  assert.ok(result.locks[0].includes('B'), 'the row lock includes the active branch')
  assert.equal(result.writes.length, 2)
})

test('a sale creator cannot read somebody else’s sale detail or use another branch as own', async () => {
  for (const [created_by, branch_id] of [['OTHER', 'B'], ['U', 'OTHER']]) {
    const db = { sale: { findFirst: async () => ({ id: 'S', created_by, branch_id }) } }
    const res = jsonResponse(); let error
    await withMocks({
      [require.resolve('../src/models/prisma')]: { prisma: db },
      [require.resolve('../src/modules/sales/fiscalRequests')]: { fiscalEnabled: async () => false },
    }, require.resolve('../src/modules/sales/controller'), controller => controller.getById({ params: { id: 'S' }, companyId: 'A', branchId: 'B', user: { sub: 'U', permissions: ['sales.create'] } }, res, e => { error = e }))
    assert.equal(error, undefined)
    assert.equal(res.statusCode, 404)
  }
})
test('creators retain own results; Agenda confirmation can read only an accessible linked engagement',async()=>{
  const origin='11111111-1111-4111-8111-111111111111'
  for(const kind of ['own','agenda','hiddenAgenda']){
    const record={id:'S',branch_id:'B',created_by:kind==='own'?'U':'OTHER',origin_engagement_id:kind==='own'?null:origin,sale_items:[],status:{name:'Borrador'},settlement_source:'APPOINTMENT'}
    const db={sale:{findFirst:async()=>record},companyModule:{findMany:async()=>[{module_code:'appointments',status:'ACTIVE'}]},appointmentEngagement:{findFirst:async({where})=>{assert.equal(where.id,origin);assert.equal(where.company_id,'A');assert.equal(where.branch_id,'B');assert.ok(where.OR,'own/team Agenda visibility is retained');return kind==='agenda'?{id:origin}:null}}}
    const res=jsonResponse();let error
    const permissions=['sales.create','appointments.view','appointments.issue_sale','receivables.view']
    await withMocks({[require.resolve('../src/models/prisma')]:{prisma:db},[require.resolve('../src/modules/sales/fiscalRequests')]:{fiscalEnabled:async()=>false}},require.resolve('../src/modules/sales/controller'),controller=>controller.getById({params:{id:'S'},companyId:'A',branchId:'B',user:{sub:'U',permissions}},res,e=>{error=e}))
    assert.equal(error,undefined)
    assert.equal(res.statusCode,kind==='hiddenAgenda'?404:200)
    if(kind!=='hiddenAgenda')assert.equal(res.body.capabilities.viewDocument,kind==='own')
  }
})

async function editStock(permissions, stock) {
  const state = { product: { id: 'P', company_id: 'A', kind: 'STANDARD', stock: 1 }, branch: { stock: 1, min_stock: 0 }, movements: [] }
  const db = {
    product: { findFirst: async () => state.product, update: async ({ data }) => { Object.assign(state.product, data); return { ...state.product } } },
    productStock: { findUnique: async () => state.branch, findMany: async () => [{ product_id: 'P', ...state.branch }], update: async ({ data }) => Object.assign(state.branch, data) },
    $transaction: async fn => { const before = structuredClone(state); try { return await fn(db) } catch (error) { Object.assign(state, before); throw error } },
  }
  const physical = require('../src/services/units/physical')
  const res = jsonResponse(); let error
  await withMocks({
    [require.resolve('../src/models/prisma')]: { prisma: db, prismaTransaction: db },
    [require.resolve('../src/services/units/physical')]: { ...physical, lockPhysicalProducts: async () => new Map([['P', state.product]]) },
    [require.resolve('../src/services/stockAvailability')]: { ensureBranchStockRows: async () => {} },
    [require.resolve('../src/services/stockLocations')]: { applyBranchDelta: async (...args) => state.movements.push(args) },
    [require.resolve('../src/services/stockAlerts')]: { ensureStockAlert: async () => {} },
  }, require.resolve('../src/modules/inventory/products.controller'), controller => controller.update({ companyId: 'A', branchId: 'B', params: { id: 'P' }, body: { name: 'Editado', stock }, user: { sub: 'U', permissions } }, res, e => { error = e }))
  return { state, res, error }
}
test('editing product data cannot change stock without adjustment authority', async () => {
  const result = await editStock(['products.edit'], 12)
  assert.equal(result.error?.status || result.res.statusCode, 403)
  assert.equal(result.state.branch.stock, 1)
  assert.deepEqual(result.state.movements, [])
})
test('unchanged stock does not prevent ordinary product editing', async () => {
  const result = await editStock(['products.edit'], '1.000')
  assert.equal(result.error, undefined)
  assert.equal(result.res.statusCode, 200)
  assert.equal(result.state.product.name, 'Editado')
  assert.deepEqual(result.state.movements, [])
})
test('an authorized stock adjustment still executes the existing physical writer', async () => {
  const result = await editStock(['products.edit', 'stock_moves.adjust'], 12)
  assert.equal(result.error, undefined)
  assert.equal(Number(result.state.branch.stock), 12)
  assert.equal(result.state.movements.length, 1)
})
