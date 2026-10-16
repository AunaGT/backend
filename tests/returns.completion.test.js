const test = require('node:test')
const assert = require('node:assert/strict')

const {
  approveReturn,
  buildCompletionPlan,
  completeReturn,
  planReceivableReturn,
} = require('../src/modules/returns/application')
const {
  planApplicationRelease,
  releaseSaleOverpayment,
} = require('../src/modules/receivables/domain/receivables')

const approvedReturn = {
  id: 'return-1',
  return_date: new Date('2026-01-11T12:00:00Z'),
  total_refund: 18,
  status: { name: 'Aprobada' },
  approved_resolution: 'REFUND_CASH',
  return_items: [
    { id: 11, product_id: 'product-1', qty_returned: 2, refund_amount: 18 },
  ],
  sale: {
    date: new Date('2026-01-01T12:00:00Z'),
    status: {name:'Completada'},
    id: 'sale-1',
    branch_id: 'branch-1',
    total: 90,
    total_returned: 0,
    adjusted_total: 90,
    customer_contact_id: null,
    payment_method: { id: 1, is_credit: false },
    paymentEntries: [],
  },
}

test('solo una devolución aprobada puede construir su liquidación', () => {
  assert.throws(() => buildCompletionPlan({
    ...approvedReturn,
    status: { name: 'Pendiente' },
  }, {
    idempotency_key: 'finish-1',
    lines: [{ return_item_id: 11, received_qty: 2, disposition: 'SELLABLE', stock_location_id: 'loc-1' }],
    settlement: { payment_method_id: 1, cash_register_session_id: 'cash-1' },
  }), /aprobarse/i)
})

test('restaura únicamente lo recibido y exige ubicación para stock físico', () => {
  const plan = buildCompletionPlan(approvedReturn, {
    idempotency_key: 'finish-1',
    lines: [{ return_item_id: 11, received_qty: 2, disposition: 'SELLABLE', stock_location_id: 'loc-1' }],
    settlement: { payment_method_id: 1, cash_register_session_id: 'cash-1' },
  })
  assert.deepEqual(plan.lines, [{
    return_item_id: 11,
    product_id: 'product-1',
    received_qty: 2,
    restock_qty: 2,
    disposition: 'SELLABLE',
    stock_location_id: 'loc-1',
  }])
  assert.throws(() => buildCompletionPlan(approvedReturn, {
    idempotency_key: 'finish-2',
    lines: [{ return_item_id: 11, received_qty: 2, disposition: 'QUARANTINE' }],
    settlement: {},
  }), /ubicación/i)
})

test('desecho registra recepción sin inflar inventario', () => {
  const plan = buildCompletionPlan(approvedReturn, {
    idempotency_key: 'finish-3',
    lines: [{ return_item_id: 11, received_qty: 2, disposition: 'SCRAP' }],
    settlement: { payment_method_id: 1, cash_register_session_id: 'cash-1' },
  })
  assert.equal(plan.lines[0].restock_qty, 0)
  assert.equal(plan.lines[0].stock_location_id, null)
})

test('el neto guardado conserva el descuento y nunca reduce SaleItem.qty', () => {
  const plan = buildCompletionPlan(approvedReturn, {
    idempotency_key: 'finish-discount',
    lines: [{ return_item_id: 11, received_qty: 2, disposition: 'SCRAP' }],
    settlement: { payment_method_id: 1, cash_register_session_id: 'cash-1' },
  })
  assert.deepEqual(plan.saleAdjustment, {
    total_returned: 18,
    adjusted_total: 72,
  })
  assert.equal(Object.hasOwn(plan.saleAdjustment, 'sale_items'), false)
})

test('en crédito primero baja la deuda y solo libera abonos que exceden el nuevo total', () => {
  assert.deepEqual(planReceivableReturn({ adjustedTotal: 100, paid: 0, refundAmount: 30 }), {
    newAdjustedTotal: 70,
    creditOffset: 30,
    refundable: 0,
    releaseApplications: 0,
  })
  assert.deepEqual(planReceivableReturn({ adjustedTotal: 100, paid: 90, refundAmount: 30 }), {
    newAdjustedTotal: 70,
    creditOffset: 10,
    refundable: 20,
    releaseApplications: 20,
  })
})

test('libera primero la aplicación más reciente sin crear pagos positivos', () => {
  assert.deepEqual(planApplicationRelease([
    { id: 'old', amount: 50, created_at: new Date('2026-01-01') },
    { id: 'new', amount: 40, created_at: new Date('2026-02-01') },
  ], 20), [
    { id: 'new', release: 20, remaining: 20 },
  ])
  assert.throws(() => planApplicationRelease([{ id: 'a', amount: 5 }], 6), /excede/i)
})

test('aprobar conserva la solicitud original y no produce efectos físicos o financieros', async () => {
  const changes = []
  const row = {
    ...approvedReturn,
    status: { name: 'Pendiente' },
    requested_resolution: 'REFUND_CASH',
  }
  const tx = {
    systemSetting: {findUnique:async()=>({value:JSON.stringify({enabledResolutions:['REFUND_TRANSFER']})})},
    $queryRaw: async () => [{ id: row.id }],
    return: {
      findFirst: async () => row,
      update: async ({ data }) => { changes.push(['return', data]); return { ...row, ...data } },
    },
    returnStatus: { findFirst: async () => ({ id: 2, name: 'Aprobada' }) },
    returnItem: { update: async ({ where, data }) => { changes.push(['line', where.id, data]) } },
    stockLocation: {
      findMany: async () => [{ id: 'loc-1', pickable: true, warehouse: { branch_id: 'branch-1', active: true } }],
    },
  }

  await approveReturn(tx, {
    companyId: 'A',
    id: row.id,
    scope: { branch_id: 'branch-1' },
    userId: 'user-1',
    resolution: 'REFUND_TRANSFER',
    lines: [{ return_item_id: 11, disposition: 'SELLABLE', stock_location_id: 'loc-1' }],
    policy: { enabledResolutions: ['REFUND_TRANSFER'] },
  })

  assert.equal(row.requested_resolution, 'REFUND_CASH')
  assert.equal(changes[0][1].approved_resolution, 'REFUND_TRANSFER')
  assert.deepEqual(changes[1], ['line', 11, { disposition: 'SELLABLE', stock_location_id: 'loc-1' }])
})

test('desasigna el excedente y deja la venta con estado coherente', async () => {
  const entries = [
    { id: 'old', amount: 50, created_at: new Date('2026-01-01') },
    { id: 'new', amount: 40, created_at: new Date('2026-02-01') },
  ]
  let paymentStatus = 'PAID'
  const tx = {
    salePaymentEntry: {
      findMany: async () => entries,
      update: async ({ where, data }) => { entries.find((row) => row.id === where.id).amount = data.amount },
      delete: async ({ where }) => entries.splice(entries.findIndex((row) => row.id === where.id), 1),
    },
    sale: {
      findUnique: async () => ({status:{name:'Completada'}, adjusted_total: 70, paymentEntries: entries }),
      update: async ({ data }) => { paymentStatus = data.payment_status },
    },
  }
  assert.equal(await releaseSaleOverpayment(tx, 'sale-1', 20), 20)
  assert.deepEqual(entries.map((row) => [row.id, row.amount]), [['old', 50], ['new', 20]])
  assert.equal(paymentStatus, 'PAID')
})

function completionFixture({ failSettlement = false } = {}) {
  const state = {
    stock: 0,
    status: 'Aprobada',
    sale: { ...approvedReturn.sale },
    lines: approvedReturn.return_items.map((line) => ({ ...line })),
    settlements: [],
  }
  const tx = {
    systemSetting: {findUnique:async()=>null},
    $queryRaw: async () => [{ id: approvedReturn.id }],
    $executeRaw:async()=>0,
    companyPaymentMethod:{findFirst:async()=>({enabled:true,payment_method:{id:1,name:'Efectivo',is_credit:false}})},
    return: {
      findFirst: async () => ({ ...approvedReturn, status: { name: state.status }, sale: state.sale, return_items: state.lines }),
      update: async ({ data }) => {
        if (data.status_id === 4) state.status = 'Completada'
        return { ...approvedReturn, ...data, status: { name: state.status }, sale: state.sale, return_items: state.lines }
      },
    },
    returnStatus: { findFirst: async () => ({ id: 4, name: 'Completada' }) },
    returnItem: {
      update: async ({ where, data }) => Object.assign(state.lines.find((line) => line.id === where.id), data),
    },
    returnSettlement: {
      findFirst: async ({ where }) => state.settlements.find((row) => row.return_id === where.return_id && row.idempotency_key === where.idempotency_key) || null,
      create: async ({ data }) => {
        if (failSettlement) throw new Error('caja no disponible')
        const row = { id: `settlement-${state.settlements.length + 1}`, ...data }
        state.settlements.push(row)
        return row
      },
    },
    stockLocation: { findMany: async () => [{ id: 'loc-1', pickable: true }] },
    cashRegisterSession: { findFirst: async () => ({ id: 'cash-1', status: 'OPEN' }) },
    paymentMethod: { findUnique: async () => ({ id: 1, name: 'Efectivo', is_credit: false }) },
    sale: {
      update: async ({ data }) => Object.assign(state.sale, data),
    },
  }
  const client = {
    $transaction: async (callback) => {
      const snapshot = structuredClone(state)
      try { return await callback(tx) } catch (error) { Object.assign(state, snapshot); throw error }
    },
  }
  const deps = {
    restoreStock: async (_tx, lines) => { state.stock += lines.reduce((sum, line) => sum + line.restock_qty, 0) },
    ensureAlerts: async () => {},
  }
  const params = {
    companyId:'A',
    id: approvedReturn.id,
    scope: { branch_id: 'branch-1' },
    userId: 'user-1',
    payload: {
      idempotency_key: 'finish-once',
      lines: [{ return_item_id: 11, received_qty: 2, disposition: 'SELLABLE', stock_location_id: 'loc-1' }],
      settlement: { payment_method_id: 1, cash_register_session_id: 'cash-1' },
    },
  }
  return { state, client, deps, params,tx }
}

test('new refund requires current availability and rolls back stock',async()=>{
  const f=completionFixture();f.params.companyId='A';f.tx.$executeRaw=async()=>0
  f.tx.companyPaymentMethod={findFirst:async()=>({enabled:false,payment_method:{id:1,is_credit:false,name:'Efectivo'}})}
  await assert.rejects(completeReturn(f.client,f.params,f.deps),e=>e.code==='PM_DISABLED')
  assert.equal(f.state.stock,0);assert.equal(f.state.settlements.length,0)
})

test('Aprobada se completa una sola vez con la misma clave', async () => {
  const fixture = completionFixture()
  const first = await completeReturn(fixture.client, fixture.params, fixture.deps)
  const second = await completeReturn(fixture.client, fixture.params, fixture.deps)
  assert.equal(first.status.name, 'Completada')
  assert.equal(second._idempotent, true)
  assert.equal(fixture.state.stock, 2)
  assert.equal(fixture.state.sale.adjusted_total, 72)
  assert.equal(fixture.state.settlements.length, 1)
})

test('un fallo al registrar la salida de caja revierte inventario y venta', async () => {
  const fixture = completionFixture({ failSettlement: true })
  await assert.rejects(() => completeReturn(fixture.client, fixture.params, fixture.deps), /caja no disponible/)
  assert.equal(fixture.state.stock, 0)
  assert.equal(fixture.state.sale.adjusted_total, 90)
  assert.equal(fixture.state.status, 'Aprobada')
  assert.equal(fixture.state.settlements.length, 0)
})

test('current return policy blocks completion before physical or financial effects',async()=>{
  for(const configured of [{enabledResolutions:['REFUND_TRANSFER']},{windowDays:5}]) {
    const f=completionFixture();f.tx.systemSetting.findUnique=async({where})=>{assert.equal(where.company_id_key.company_id,'A');return {value:JSON.stringify(configured)}}
    await assert.rejects(completeReturn(f.client,f.params,f.deps),e=>e.status===409 && /política|plazo/i.test(e.message))
    assert.equal(f.state.stock,0);assert.equal(f.state.sale.adjusted_total,90);assert.equal(f.state.settlements.length,0)
  }
})
test('approval rechecks the latest company policy after locking and before changing the request',async()=>{
  for(const policy of [{windowDays:5},{enabledResolutions:['REFUND_TRANSFER']},{windowDays:5,allowAuthorizedExceptions:false}]) {
    let changes=0
    const row={...approvedReturn,status:{name:'Pendiente'},requested_resolution:'REFUND_CASH'}
    const tx={$queryRaw:async()=>[],return:{findFirst:async()=>row,update:async()=>{changes++;return row}},systemSetting:{findUnique:async({where})=>{assert.equal(where.company_id_key.company_id,'A');return {value:JSON.stringify(policy)}}},returnStatus:{findFirst:async()=>({id:2})},returnItem:{update:async()=>{changes++}},stockLocation:{findMany:async()=>[]}}
    await assert.rejects(approveReturn(tx,{id:row.id,companyId:'A',scope:{branch_id:'branch-1'},resolution:'REFUND_CASH',lines:[{return_item_id:11,disposition:'SCRAP'}]}),e=>e.status===409)
    assert.equal(changes,0)
  }
})
test('processing delay does not expire a timely request and completed retries ignore later policy changes',async()=>{
  const f=completionFixture();await completeReturn(f.client,f.params,f.deps)
  f.tx.systemSetting.findUnique=async()=>{throw Error('Una liquidación ya confirmada no se revalida')}
  assert.equal((await completeReturn(f.client,f.params,f.deps))._idempotent,true);assert.equal(f.state.stock,2)
})
test('completion never invents an exception authorization or missing request date',async()=>{
  for(const extra of [{policy_override_reason:'Motivo sin autor'},{policy_overridden_by:'U',policy_overridden_at:new Date(),policy_override_reason:' '},{return_date:null}]) {
    const f=completionFixture(),read=f.tx.return.findFirst
    f.tx.return.findFirst=async args=>({...await read(args),...extra})
    f.tx.systemSetting.findUnique=async()=>({value:JSON.stringify({windowDays:5})})
    await assert.rejects(completeReturn(f.client,f.params,f.deps),e=>e.status===409)
    assert.equal(f.state.stock,0);assert.equal(f.state.settlements.length,0)
  }
})
test('completion honors audited exceptions only while the current policy permits them',async()=>{
  for(const allowed of [true,false]) {
    const f=completionFixture(),read=f.tx.return.findFirst
    f.tx.return.findFirst=async args=>({...await read(args),policy_overridden_by:'U',policy_overridden_at:new Date('2026-01-11T12:00:00Z'),policy_override_reason:'Garantía autorizada'})
    f.tx.systemSetting.findUnique=async()=>({value:JSON.stringify({windowDays:5,allowAuthorizedExceptions:allowed})})
    if(allowed) await completeReturn(f.client,f.params,f.deps);else await assert.rejects(completeReturn(f.client,f.params,f.deps),e=>e.status===409)
    assert.equal(f.state.stock,allowed?2:0)
  }
})

test('approval and completion decode the stored Guatemala request clock before enforcing the window',async()=>{
  // The production writer stores Guatemala wall-clock components as UTC.
  // Actual request: Feb 1 at 12Z (06:00 Guatemala), exactly period 31.
  const storedDate=new Date('2026-02-01T06:00:00Z')
  const policy={windowDays:30,allowAuthorizedExceptions:false,enabledResolutions:['REFUND_CASH']}
  const f=completionFixture(),read=f.tx.return.findFirst
  f.tx.return.findFirst=async args=>({...await read(args),return_date:storedDate})
  f.tx.systemSetting.findUnique=async()=>({value:JSON.stringify(policy)})
  await assert.rejects(completeReturn(f.client,f.params,f.deps),e=>e.status===409 && /plazo/i.test(e.message))
  assert.equal(f.state.stock,0);assert.equal(f.state.settlements.length,0)
  let writes=0
  const row={...approvedReturn,return_date:storedDate,status:{name:'Pendiente'},requested_resolution:'REFUND_CASH'}
  const tx={$queryRaw:async()=>[],return:{findFirst:async()=>row,update:async()=>{writes++;return row}},systemSetting:{findUnique:async()=>({value:JSON.stringify(policy)})},returnStatus:{findFirst:async()=>({id:2})},returnItem:{update:async()=>{writes++}},stockLocation:{findMany:async()=>[]}}
  await assert.rejects(approveReturn(tx,{id:row.id,companyId:'A',scope:{branch_id:'branch-1'},resolution:'REFUND_CASH',lines:[{return_item_id:11,disposition:'SCRAP'}]}),e=>e.status===409 && /plazo/i.test(e.message))
  assert.equal(writes,0)
})
