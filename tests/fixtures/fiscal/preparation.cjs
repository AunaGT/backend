const ids = {
  company: '11111111-1111-4111-8111-111111111111', branch: '22222222-2222-4222-8222-222222222222', actor: '33333333-3333-4333-8333-333333333333',
  product: '44444444-4444-4444-8444-444444444444', unit: '55555555-5555-4555-8555-555555555555', presentation: '66666666-6666-4666-8666-666666666666',
  connector: '77777777-7777-4777-8777-777777777777', version: '88888888-8888-4888-8888-888888888888', sale: '99999999-9999-4999-8999-999999999999',
}
function fixture() {
  const settings = Object.entries({ company_legal_name: 'Emisor ficticio, S.A.', company_name: 'Negocio ficticio', company_nit: 'TEST-NIT', company_address: 'Dirección de prueba', company_municipality: 'Municipio', company_department: 'Departamento', company_postal_code: '01001', vat_affiliation: 'general', currency_code: 'GTQ', iva_rate: '12', pequeno_rate: '5' }).map(([key, value]) => ({ key, value, revision: 1 }))
  const draft = {
    documentType: 'FACT',
    taxRules: [{ id: 'local-included', name: 'Tasa ficticia incluida', mode: 'INCLUDED', rate: '0.12', exemptionCode: '' }],
    unitMap: [{ kind: 'UNIT', targetId: ids.unit, satCode: '01' }, { kind: 'LEGACY_PRODUCT', targetId: ids.product, satCode: '02' }, { kind: 'PRESENTATION', targetId: ids.presentation, satCode: '03' }],
    productTaxMap: [], categoryTaxMap: [{ categoryId: 10, taxRuleId: 'local-included' }],
    establishments: [{ branchId: ids.branch, code: '001', name: 'Establecimiento ficticio', address: 'Dirección local', municipality: 'Municipio', department: 'Departamento', postalCode: '01001' }],
  }
  const sale = { id: ids.sale, branch_id: ids.branch, branch: { company_id: ids.company }, is_final_consumer: true, customer: 'Consumidor final', customer_nit: null, subtotal: '112.00', discount_total: '0.00', total: '112.00', payment_status: 'PAID', unit_metadata_version: 2,
    sale_items: [{ id: 1, product_id: ids.product, item_name: 'Producto de prueba', item_kind: 'STANDARD', qty: '1', price: '112', net_total: '112.00', unit_label: 'unidad', quantity_decimals: 0, unit_metadata_version: 2, unit_snapshot: { version: 2, baseUnit: { id: ids.unit, code: 'LOCAL', name: 'Unidad', label: 'ud', decimals: 0 }, presentation: null, factor: '1', roundingDelta: '0' }, base_qty: '1' }] }
  return { ids, settings, draft, sale, scope: { companyId: ids.company, branchId: ids.branch, actorId: ids.actor, permissions: ['fiscal.manage', 'fiscal.test'] }, products: [{ id: ids.product, company_id: ids.company, category_id: 10, kind: 'STANDARD', price: '999' }] }
}
module.exports = { fixture, ids }
