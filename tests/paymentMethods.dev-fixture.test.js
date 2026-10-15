const test = require('node:test')
const assert = require('node:assert/strict')
const { getDevelopmentClient, assertPaymentMethodsMigration, createDevelopmentFixture, expectDatabaseRejection } = require('./helpers/paymentMethodsDevelopmentFixture.cjs')

test('development integration refuses to load credentials without explicit opt-in', () => {
  const previous = process.env.AUNA_DEV_PAYMENT_METHOD_TESTS
  delete process.env.AUNA_DEV_PAYMENT_METHOD_TESTS
  try { assert.throws(() => getDevelopmentClient(), { code: 'PM_DEV_OPT_IN_REQUIRED' }) }
  finally { if (previous === undefined) delete process.env.AUNA_DEV_PAYMENT_METHOD_TESTS; else process.env.AUNA_DEV_PAYMENT_METHOD_TESTS = previous }
})
test('integration requires a finished non-rolled-back migration before creating fixtures', async () => {
  const db = { $queryRaw: async () => [] }
  await assert.rejects(assertPaymentMethodsMigration(db), { code: 'PM_DEV_MIGRATION_REQUIRED' })
})
test('negative database probes roll back even when the expected database guard regresses',async()=>{
  let rows=[]
  const db={$transaction:async run=>{
    const before=[...rows]
    try{return await run({create:async()=>{rows.push('unexpected') }})}
    catch(e){rows=before;throw e}
  }}
  await assert.rejects(expectDatabaseRejection(db,tx=>tx.create()),{code:'PM_DEV_PROBE_ACCEPTED'})
  assert.deepEqual(rows,[])
  const expected=Object.assign(new Error('constraint'),{code:'P2002'})
  assert.equal(await expectDatabaseRejection(db,async()=>{throw expected},e=>e.code==='P2002'),expected)
  await assert.rejects(expectDatabaseRejection(db,async()=>{throw new Error('Network failure')},e=>e.code==='P2002'),/Network failure/)
})
test('fixture cleanup removes auto-created accounting periods only in its own companies',async()=>{
  const companies=new Set(),periods=new Set(['unrelated-company'])
  const empty={create:async()=>({}),deleteMany:async()=>({count:0}),findMany:async()=>[],updateMany:async()=>({count:0})}
  const db={$queryRaw:async()=>[{migration_name:'202610150002_company_payment_methods'}],role:{findFirst:async()=>({id:1})},
    company:{create:async({data})=>{companies.add(data.id);periods.add(data.id)},deleteMany:async({where})=>{
      for(const id of where.id.in){if(periods.has(id))throw new Error('Accounting period still references company');companies.delete(id)}
    }},
    paymentMethod:{...empty,findMany:async()=>[{id:1},{id:2},{id:3},{id:4}]},
    companyPaymentMethod:{...empty,createMany:async()=>({count:4})},
    accountingPeriod:{deleteMany:async({where})=>{for(const id of where.company_id.in)periods.delete(id)}},
  }
  for(const model of ['user','branch','supplier','appointmentEngagement','journalEntry','appointmentRequest','appointmentEngagementHistory','paymentAllocationEvent','salePaymentEntry','sale','saleHistory','saleItem','paymentCommitment','customerPayment','appointmentEngagementLine','product','productCategory','systemSetting','companyModule','account'])db[model]=empty
  db.$transaction=async run=>run(db)
  const f=await createDevelopmentFixture(db)
  await f.cleanup()
  assert.equal(companies.size,0)
  assert.deepEqual([...periods],['unrelated-company'])
})
