const test = require('node:test')
const assert = require('node:assert/strict')
const { seedCompanySettings } = require('../src/services/companySettings')

test('inicializa ajustes sin agotar el presupuesto en viajes individuales a la base', async () => {
  let elapsed = 0
  const rows = new Map()
  function write(data) {
    elapsed += 250
    if (elapsed > 5000) throw Object.assign(new Error('Transaction expired'), { code: 'P2028' })
    for (const row of data) rows.set(row.key, row)
  }
  await seedCompanySettings({ systemSetting: {
    upsert: async ({ create }) => write([create]),
    createMany: async ({ data }) => write(data),
  } }, 'company-a', { name: 'Empresa A', tax_id: '123', logo_url: '/logo.png' })
  assert.equal(rows.size, 26)
  assert.deepEqual(JSON.parse(rows.get('inventory.expiry_alert_policy').value),{warningDays:30,highPriorityDays:7})
  assert.equal(rows.get('fel_enabled').value,'false')
  assert.deepEqual(rows.get('company_name'), { company_id: 'company-a', key: 'company_name', value: 'Empresa A', type: 'string' })
  assert.equal(rows.get('company_nit').value, '123')
  assert.equal(rows.get('company_logo_url').value, '/logo.png')
  assert.equal(rows.get('currency_code').value, 'GTQ')
  assert.equal(rows.get('returns.policy').type, 'json')
})

test('repetir la inicialización conserva ajustes personalizados y separa empresas', async () => {
  const rows = new Map()
  const original = { company_id: 'company-a', key: 'currency_code', value: 'USD', type: 'string', description: 'Personalizada', updated_at: 'original' }
  rows.set('company-a:currency_code', original)
  const expiry={company_id:'company-a',key:'inventory.expiry_alert_policy',value:JSON.stringify({warningDays:12,highPriorityDays:2}),type:'json'}
  rows.set('company-a:inventory.expiry_alert_policy',expiry)
  const tx = { systemSetting: {
    upsert: async ({ create }) => {
      const key = `${create.company_id}:${create.key}`
      if (!rows.has(key)) rows.set(key, create)
    },
    createMany: async ({ data, skipDuplicates }) => {
      for (const row of data) {
        const key = `${row.company_id}:${row.key}`
        if (rows.has(key)) {
          if (!skipDuplicates) throw new Error('Duplicate setting')
        } else rows.set(key, row)
      }
    },
  } }
  await seedCompanySettings(tx, 'company-a', { name: 'Empresa A' })
  await seedCompanySettings(tx, 'company-a', { name: 'No sobrescribir' })
  await seedCompanySettings(tx, 'company-b', { name: 'Empresa B' })
  assert.equal(rows.size, 52)
  assert.deepEqual(rows.get('company-a:inventory.expiry_alert_policy'),expiry)
  assert.deepEqual(rows.get('company-a:currency_code'), original)
  assert.equal(rows.get('company-a:company_name').value, 'Empresa A')
  assert.equal(rows.get('company-b:currency_code').value, 'GTQ')
  assert.equal(rows.get('company-b:company_name').value, 'Empresa B')
})
