const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { defaultCompanySettings } = require('../src/services/companySettings')

test('una empresa nueva nace con experiencia de venta compatible y explícita', () => {
  const settings = new Map(defaultCompanySettings({ name: 'Tienda' }).map(([key, value]) => [key, value]))
  assert.equal(settings.get('default_experience_profile'), 'CASHIER')
  assert.equal(settings.get('sales_allow_credit'), 'true')
  assert.equal(settings.get('sales_show_fiscal_fields'), 'true')
  assert.equal(settings.get('sales_show_channels'), 'true')
})

test('el perfil se persiste por membresía usuario-empresa y no en User', () => {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'prisma', 'schema.prisma'), 'utf8')
  const membership = schema.match(/model UserCompany \{[\s\S]*?\n\}/)?.[0] ?? ''
  const user = schema.match(/model User \{[\s\S]*?\n\}/)?.[0] ?? ''
  assert.match(membership, /experience_profile\s+ExperienceProfile\?/)
  assert.doesNotMatch(user, /experience_profile/)
})
