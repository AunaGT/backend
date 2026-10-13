const test = require('node:test')
const assert = require('node:assert/strict')
const { nameMatcher, checkSimilarity, checkText, rowSet, validMoney } = require('../src/utils/importValidation')

test('parecidos: acentos, orden, un carácter y cantidades diferentes', () => {
  const match = nameMatcher([{ name: 'Café molido 500 g' }, { name: 'Contado' }])
  assert.ok(match('Cafe molido 500 g', 2).length)
  assert.ok(match('molido Cafe 500 g', 3).length)
  assert.ok(match('Contadoo', 4).length)
  assert.equal(match('Café molido 250 g', 5).length, 0)
  const issue = checkSimilarity({ rowIndex: 6, valid: true, errors: [] }, 'Contado', match, {})
  assert.equal(issue.canCreateAnyway, true)
  assert.equal(checkSimilarity({ rowIndex: 6, valid: true, errors: [] }, 'Contado', match, { allowSimilarRowIndexes: [6] }).valid, true)
  const hard = checkSimilarity({ rowIndex: 7, valid: false, errors: ['Correo duplicado'] }, 'Contado', match, { allowSimilarRowIndexes: [7] })
  assert.deepEqual(hard.errors, ['Correo duplicado'])
  const errors = []
  checkText({ name: 'a\0b', code: '123' }, { name: 2, code: 2 }, errors)
  assert.equal(errors.length, 3)
  assert.deepEqual([...rowSet({ skipRowIndexes: ['2', 2, NaN, 2.5] }, 'skipRowIndexes')], [2])
  assert.equal(validMoney(9999999999.99), true)
  assert.equal(validMoney(12.001), false)
  assert.equal(validMoney(Infinity), false)
  assert.equal(validMoney(1e10), false)
  assert.equal(validMoney(-1), false)
})

test('los cuatro servicios revalidan decisiones sin saltarse errores obligatorios', async () => {
  const prismaPath = require.resolve('../src/models/prisma')
  const accessPath = require.resolve('../src/services/userAccess')
  const stockPath = require.resolve('../src/services/stockLocations')
  const paths = ['bulkImport', 'supplierBulkImport', 'userBulkImport', 'catalogBulkImport'].map(name => require.resolve(`../src/services/${name}`))
  const companyId = 'company-a'
  const prisma = {
    productCategory: { findMany: async () => [{ id: 1, name: 'Bebidas' }] },
    paymentTerm: { findMany: async () => [{ id: 1, name: 'Contado' }] },
    product: { findMany: async ({ select, where }) => {
      assert.equal(where.company_id, companyId)
      return select.barcode ? [{ id: 'product-a', barcode: 'ABC' }] : [{ id: 'product-a', name: 'Cafe molido' }]
    } },
    supplier: { findMany: async () => [{ id: 'supplier-a', name: 'Proveedor Uno', email: 'existing@test.com', tax_id: 'NIT1' }] },
    role: { findMany: async () => [{ id: 'role-a', name: 'viewer', permissions: [] }] },
    user: { findMany: async ({ where }) => where.email ? [{ email: 'existing@test.com' }] : [{ name: 'Juan Perez' }] },
  }
  require.cache[prismaPath] = { exports: { prisma } }
  require.cache[accessPath] = { exports: { assertGrant() {}, fail(status, message) { throw Error(message) } } }
  require.cache[stockPath] = { exports: { applyBranchDelta() {} } }
  paths.forEach(path => { delete require.cache[path] })
  try {
    const { validateBulkData } = require(paths[0])
    const product = { name: 'Café molido', category: 'Bebidas', supplier: 'Proveedor Uno', price: '10', stock: 1 }
    let v = await validateBulkData([product], {}, { companyId })
    assert.equal(v.invalidRows[0].canCreateAnyway, true)
    v = await validateBulkData([product], { allowSimilarRowIndexes: [2] }, { companyId })
    assert.equal(v.totals.valid, 1)
    v = await validateBulkData([{ ...product, price: '10abc', stock: '1.2', tracks_expiry: 'quizás' }], { allowSimilarRowIndexes: [2] }, { companyId })
    assert.equal(v.invalidRows[0].errors.length, 3)
    v = await validateBulkData([{ ...product, barcode: 'ABC' }, { ...product, barcode: 'ABC' }], {}, { companyId })
    assert.equal(v.validRows[0].existingProductId, 'product-a')
    assert.match(v.invalidRows[0].errors.join(), /duplicado en el archivo/)
    v = await validateBulkData([{ ...product, category: 'No existe' }], { skipRowIndexes: [2] }, { companyId })
    assert.equal(v.totals.skipped, 1)
    assert.deepEqual(v.resolutionHints, [])

    const { bulkValidateSuppliers } = require(paths[1])
    const supplier = { name: 'Proveedor Umo', contact: 'Ana', phone: '+502 2222-3333', email: 'new@test.com', address: 'Guatemala', category: 'Bebidas', payment_terms: 'Contado' }
    v = await bulkValidateSuppliers([supplier], {}, { companyId })
    assert.equal(v.invalidRows[0].canCreateAnyway, true)
    v = await bulkValidateSuppliers([supplier], { allowSimilarRowIndexes: [2] }, { companyId })
    assert.equal(v.totals.valid, 1)
    v = await bulkValidateSuppliers([{ ...supplier, email: 'existing@test.com', phone: 'abc', tax_id: 'NIT1' }], { allowSimilarRowIndexes: [2] }, { companyId })
    assert.equal(v.totals.invalid, 1)
    assert.equal(v.invalidRows[0].errors.length, 3)

    const { bulkValidateUsers } = require(paths[2])
    const user = { name: 'Juan Pérez', email: 'new@test.com', password: 'strong-password', role: 'viewer' }
    v = await bulkValidateUsers([user], {}, { companyId, user: {} })
    assert.equal(v.invalidRows[0].canCreateAnyway, true)
    assert.equal(v.invalidRows[0].data, undefined, 'la respuesta de errores no expone contraseñas')
    v = await bulkValidateUsers([user], { allowSimilarRowIndexes: [2] }, { companyId, user: {} })
    assert.equal(v.totals.valid, 1)
    v = await bulkValidateUsers([{ ...user, email: 'existing@test.com' }], { allowSimilarRowIndexes: [2] }, { companyId, user: {} })
    assert.equal(v.totals.invalid, 1)
    v = await bulkValidateUsers([{ ...user, role: 'missing' }], { skipRowIndexes: [2] }, { companyId, user: {} })
    assert.equal(v.totals.skipped, 1)
    assert.deepEqual(v.resolutionHints, [])

    const { bulkValidateCatalogs } = require(paths[3])
    v = await bulkValidateCatalogs([{ name: 'Bebidas!' }], 'categories', companyId)
    assert.equal(v.invalidRows[0].canCreateAnyway, true)
    v = await bulkValidateCatalogs([{ name: 'Bebidas!' }], 'categories', companyId, { allowSimilarRowIndexes: [1] })
    assert.equal(v.totals.valid, 1)
    v = await bulkValidateCatalogs([{ name: 'Bebidas' }], 'categories', companyId, { allowSimilarRowIndexes: [1] })
    assert.equal(v.totals.invalid, 1)
    v = await bulkValidateCatalogs([{ name: 'Bebidas' }], 'categories', companyId, { skipRowIndexes: [1] })
    assert.equal(v.totals.skipped, 1)
  } finally {
    for (const path of [...paths, prismaPath, accessPath, stockPath]) delete require.cache[path]
  }
})

test('contabilidad descarta el asiento completo y detecta fechas inexistentes', async () => {
  const prismaPath = require.resolve('../src/models/prisma')
  const controllerPath = require.resolve('../src/modules/accounting/import.controller')
  require.cache[prismaPath] = { exports: { prisma: {
    account: { findMany: async () => [{ id: 1, code: '100', name: 'Caja', active: true, is_group: false }] },
    accountingPeriod: { findMany: async ({ where }) => { assert.equal(where.company_id, 'company-a'); return [] } },
  } } }
  delete require.cache[controllerPath]
  try {
    const ctrl = require(controllerPath)
    const items = [
      { reference: 'AP1', date: '31/02/2026', accountCode: '100', debit: 10 },
      { reference: 'AP1', date: '31/02/2026', accountCode: '100', credit: 10 },
    ]
    let response
    const res = { json: value => { response = value } }
    const next = error => { throw error }
    await ctrl.validateJournalImport({ body: { items }, companyId: 'company-a' }, res, next)
    assert.equal(response.totals.invalid, 2)
    await ctrl.validateJournalImport({ body: { items, importOptions: { skipRowIndexes: [0] } }, companyId: 'company-a' }, res, next)
    assert.equal(response.totals.skipped, 2)
    assert.equal(response.totals.invalid, 0)
    assert.equal(response.entries, 0)
    const repeated = [
      { reference: 'AP2', date: '2026-02-28', accountCode: '100', debit: 10 },
      { reference: 'AP2', date: '2026-02-28', accountCode: '100', debit: 10 },
      { reference: 'AP2', date: '2026-02-28', accountCode: '100', credit: 20 },
    ]
    await ctrl.validateJournalImport({ body: { items: repeated }, companyId: 'company-a' }, res, next)
    assert.equal(response.invalidRows[0].canCreateAnyway, true)
    await ctrl.validateJournalImport({ body: { items: repeated, importOptions: { allowSimilarRowIndexes: [1] } }, companyId: 'company-a' }, res, next)
    assert.equal(response.totals.invalid, 0)
    repeated[1].debit = '1,2'
    await ctrl.validateJournalImport({ body: { items: repeated, importOptions: { allowSimilarRowIndexes: [1] } }, companyId: 'company-a' }, res, next)
    assert.ok(response.invalidRows.some(row => row.errors.some(error => error.includes('montos inválidos'))))
  } finally {
    delete require.cache[controllerPath]
    delete require.cache[prismaPath]
  }
})
