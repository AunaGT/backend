const test = require('node:test')
const assert = require('node:assert/strict')
const { withMocks, jsonResponse } = require('./helpers/reportHarness.cjs')
const target = require.resolve('../src/modules/config/controller')
const model = require.resolve('../src/models/prisma')
const timezone = require.resolve('../src/utils/getTimezone')

function settingsDb({ failCompany = false, failKey = null } = {}) {
  const state = { rows: new Map(), company: { name: 'Anterior' }, transactions: 0 }
  const keyOf = row => `${row.company_id}:${row.key}`
  const read = (rows, { where }) => [...rows.values()].filter(row => row.company_id === where.company_id)
  const db = {
    systemSetting: {
      findMany: args => read(state.rows, args),
      upsert: async () => { throw new Error('Escritura fuera de transacción') },
    },
    company: { update: async () => { throw new Error('Company fuera de transacción') } },
    $transaction: async (run, options) => {
      state.transactions++
      assert.equal(options.timeout, 30_000)
      assert.equal(options.maxWait, 15_000)
      const rows = new Map(state.rows)
      let company = { ...state.company }
      const tx = {
        $queryRaw:async()=>[],
        systemSetting: {
          create:async({data})=>{
            if(data.key===failKey)throw Error('Fallo de clave')
            const key=keyOf(data);if(rows.has(key))throw Object.assign(Error('Duplicado'),{code:'P2002'})
            rows.set(key,{...data,revision:1});return rows.get(key)
          },
          upsert: async ({ where, create, update }) => {
            assert.equal(where.company_id_key.company_id, create.company_id)
            if (create.key === failKey) throw new Error('Fallo de clave')
            const key = keyOf(create)
            rows.set(key, rows.has(key) ? { ...rows.get(key), ...update } : create)
          },
          findMany: async args => read(rows, args),
        },
        company: { update: async ({ where, data }) => {
          assert.equal(where.id, 'A')
          if (failCompany) throw new Error('Fallo Company')
          company = { ...company, ...data }
        } },
      }
      const result = await run(tx)
      state.rows = rows
      state.company = company
      return result
    },
  }
  return { db, state }
}

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
  db.$queryRaw=async()=>[]
  db.systemSetting.create=async({data})=>{const row={...data,revision:1};rows.set(data.key,row);return row}
  db.systemSetting.updateMany=async({where,data})=>{const row=rows.get(where.key);if(row?.revision!==where.revision)return{count:0};rows.set(where.key,{...row,...data,revision:row.value===data.value?row.revision:row.revision+1});return{count:1}}
  db.$transaction = async run => run(db)
  await withMocks({ [model]: { prisma: db, prismaTransaction: db } }, target, async controller => {
    for (const [input, expected] of [[12, '12'], ['12', '12'], ['1e2', '100']]) {
      const res = jsonResponse()
      await controller.update({ companyId: 'A', body: { order_validity_days: input,expectedRevisions:{order_validity_days:rows.get('order_validity_days')?.revision??0} } }, res,
        error => { throw error })
      assert.equal(res.statusCode, 200)
      assert.equal(res.body.order_validity_days, expected)
    }
  })
})

test('PATCH conserva empresa ajena y confirma identidad y claves juntas', async () => {
  const { db, state } = settingsDb()
  const other = { company_id: 'B', key: 'company_name', value: 'Empresa B', type: 'string' }
  state.rows.set('B:company_name', other)
  const invalidations = []
  await withMocks({ [model]: { prisma: db, prismaTransaction: db },
    [timezone]: { invalidateSystemConfigCache: id => {
      assert.equal(state.company.name, 'Empresa A')
      invalidations.push(id)
    } } }, target, async controller => {
    const res = jsonResponse()
    await controller.update({ companyId: 'A', body: { expectedRevisions:{company_name:0,order_validity_days:0,cash_closure_denominations:0}, settings: {
      company_name: 'Empresa A', order_validity_days: '12',
      cash_closure_denominations: [{ denomination: 10, type: 'Billete' }],
    } } }, res, error => { throw error })
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.company_name, 'Empresa A')
    assert.deepEqual(res.body.cash_closure_denominations, [{ denomination: 10, type: 'Billete' }])
  })
  assert.equal(state.transactions, 1)
  assert.equal(state.company.name, 'Empresa A')
  assert.deepEqual(state.rows.get('B:company_name'), other)
  assert.deepEqual(invalidations, ['A'])
})

test('fallo de clave o Company no deja parcial ni invalida caché', async () => {
  for (const failure of [{ failCompany: true }, { failKey: 'order_validity_days' }]) {
    const { db, state } = settingsDb(failure)
    const invalidations = []
    let forwarded
    const res = jsonResponse()
    await withMocks({ [model]: { prisma: db, prismaTransaction: db },
      [timezone]: { invalidateSystemConfigCache: id => invalidations.push(id) } }, target,
    async controller => {
      await controller.update({ companyId: 'A', body: {
        expectedRevisions:{company_name:0,order_validity_days:0},
        company_name: 'No confirmar', order_validity_days: '12',
      } }, res, error => { forwarded = error })
    })
    assert.ok(forwarded)
    assert.equal(res.body, null)
    assert.equal(state.transactions, 1)
    assert.equal(state.rows.size, 0)
    assert.equal(state.company.name, 'Anterior')
    assert.deepEqual(invalidations, [])
  }
})
