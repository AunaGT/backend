const test = require('node:test')
const assert = require('node:assert/strict')

function loadController(t, prisma) {
  const paths = [require.resolve('../src/models/prisma'), require.resolve('../src/controllers/companies.controller'), require.resolve('../src/modules/platform/service')]
  const previous = paths.map(path => require.cache[path])
  require.cache[paths[0]] = { exports: { prisma } }
  delete require.cache[paths[1]]
  delete require.cache[paths[2]]
  t.after(() => paths.forEach((path, index) => {
    if (previous[index]) require.cache[path] = previous[index]
    else delete require.cache[path]
  }))
  return require(paths[1])
}

for (const failModules of [false, true]) {
  test(failModules ? 'un fallo al inicializar módulos no publica una empresa parcialmente creada' : 'crear empresa tolera latencia de red e inicializa ajustes, cuentas y accesos completos', async t => {
    const committed = []
    const moduleError = new Error('Module insert failed')
    const prisma = { $transaction: async (callback, options) => {
      const pending = []
      let elapsed = 0
      const query = (model, data) => {
        elapsed += 250
        if (elapsed > (options?.timeout ?? 5000)) throw Object.assign(new Error('Transaction expired'), { code: 'P2028' })
        pending.push({ model, data })
        return { id: model === 'company' ? 'company-a' : model === 'account' ? `account-${data.code}` : 'branch-a', ...data }
      }
      const tx = {
        company: { create: async ({ data }) => query('company', data) },
        branch: { create: async ({ data }) => query('branch', data) },
        userCompany: { create: async ({ data }) => query('userCompany', data) },
        userBranch: { create: async ({ data }) => query('userBranch', data) },
        systemSetting: {
          upsert: async ({ create }) => query('systemSetting', create),
          createMany: async ({ data }) => query('settings', data),
          findUnique: async () => { query('readSettings', null); return null },
        },
        account: { upsert: async ({ create }) => query('account', create) },
        companyModule: { createMany: async ({ data }) => {
          query('modules', data)
          if (failModules) throw moduleError
        } },
      }
      const result = await callback(tx)
      committed.push(...pending)
      return result
    } }
    const controller = loadController(t, prisma)
    let status, response, error
    await controller.create({ body: { name: 'Empresa A', code: 'qa', tax_id: '123' }, user: { sub: 'actor' } }, {
      status(value) { status = value; return this },
      json(value) { response = value },
    }, value => { error = value })
    if (failModules) {
      assert.equal(error, moduleError)
      assert.equal(response, undefined)
      assert.equal(committed.length, 0)
      return
    }
    assert.equal(error, undefined)
    assert.equal(status, 201)
    assert.equal(response.code, 'QA')
    assert.deepEqual(response.branches, [{ id: 'branch-a', company_id: 'company-a', name: 'Principal', code: 'PRIN', is_default: true }])
    assert.equal(committed.filter(row => row.model === 'account').length, 34)
    assert.equal(committed.find(row => row.model === 'account' && row.data.code === '1101').data.parent_id, 'account-1')
    assert.deepEqual(committed.find(row => row.model === 'userCompany').data, { user_id: 'actor', company_id: 'company-a' })
    assert.deepEqual(committed.find(row => row.model === 'userBranch').data, { user_id: 'actor', branch_id: 'branch-a' })
    const settings = committed.filter(row => row.model === 'systemSetting' || row.model === 'settings').flatMap(row => row.data)
    assert.equal(settings.find(row => row.key === 'company_name').value, 'Empresa A')
    assert.equal(JSON.parse(settings.find(row => row.key === 'accounting.defaultAccounts').value).cash, '1101')
    const modules = committed.find(row => row.model === 'modules').data
    assert.ok(modules.length > 0)
    assert.ok(modules.every(row => row.company_id === 'company-a'))
    assert.ok(modules.filter(row => row.module_code !== 'appointments').every(row => row.status === 'ACTIVE'))
    assert.equal(modules.find(row => row.module_code === 'appointments').status, 'DISABLED')
  })
}
