const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto')
const {prepareSaleSnapshot}=require('../src/modules/sales/documents/snapshot')
const {templateDb}=require('./helpers/documentTemplateHarness.cjs')
const {resolveBase}=require('../src/modules/config/documentTemplates/public')
const companyId='11111111-1111-4111-8111-111111111111',actorId='22222222-2222-4222-8222-222222222222',branchId='33333333-3333-4333-8333-333333333333'
const scope={companyId,actorId,branchId,permissions:['sales.create']}
function fixture() {
  const db=templateDb(),snapshots=[]
  const sale={id:randomUUID(),created_by:actorId,reference:'V-42',date:new Date('2026-10-22'),status:{name:'Completada'},branch_id:branchId,branch:{name:'Principal',company:{name:'Empresa'}},total:'18.90',subtotal:'18.90',discount_total:'0',sale_items:[{item_name:'Café',qty:'0.123456',price:'18.90',net_total:'18.90',unit_metadata_version:2,unit_snapshot:{version:2,baseUnit:{label:'kg'},presentation:null}}]}
  db.sale={findFirst:async({where})=>where.id===sale.id&&where.branch_id===branchId&&where.branch.company_id===companyId?sale:null}
  db.documentSnapshot={findFirst:async({where})=>snapshots.find(s=>s.company_id===where.company_id&&s.sale_id===where.sale_id),create:async({data})=>{const row={id:randomUUID(),...structuredClone(data)};snapshots.push(row);return row}}
  db.state.settings.push({company_id:companyId,key:'invoices.templates_enabled',value:'true'},{company_id:companyId,key:'company_logo_url',value:'logo-1'})
  db.state.versions.push({id:'44444444-4444-4444-8444-444444444444',state:'PUBLISHED',design:resolveBase('CLASSIC','A4')})
  db.state.defaults.push({company_id:companyId,purpose:'INTERNAL_RECEIPT',format:'A4',version_id:db.state.versions[0].id})
  return {db,sale,snapshots}
}
test('ticket preparation captures all formats; a later sheet keeps the same data, logo and template versions',async()=>{
  const {db,sale,snapshots}=fixture(),ticket=await prepareSaleSnapshot(db,scope,{saleId:sale.id,purpose:'INTERNAL_RECEIPT'})
  db.state.settings.find(s=>s.key==='company_logo_url').value='logo-2'
  db.state.defaults[0].version_id=randomUUID();sale.total='99.00';sale.sale_items[0].item_name='Modificado'
  const sheet=await prepareSaleSnapshot(db,scope,{saleId:sale.id,purpose:'INTERNAL_RECEIPT'})
  assert.equal(sheet.id,ticket.id);assert.equal(snapshots.length,1)
  assert.equal(sheet.profiles.A4.templateVersionId,'44444444-4444-4444-8444-444444444444')
  assert.equal(sheet.branding.logoRef,'logo-1');assert.equal(sheet.data.totals.total,'18.90');assert.equal(sheet.data.lines[0].name,'Café')
  assert.equal(sheet.profiles.A4.resourceRefs.find(r=>r.role==='logo').sourceUrl,'logo-1')
  assert.deepEqual(Object.keys(sheet.profiles),['LETTER','A4','RECEIPT_80'])
})
test('new fiscal documents and unconfirmed sales are never created by the template engine',async()=>{
  const {db,sale,snapshots}=fixture()
  await assert.rejects(prepareSaleSnapshot(db,scope,{saleId:sale.id,purpose:'FEL_INVOICE'}),{code:'FISCAL_CONNECTOR_UNAVAILABLE'})
  sale.status.name='Borrador'
  await assert.rejects(prepareSaleSnapshot(db,scope,{saleId:sale.id,purpose:'INTERNAL_RECEIPT'}),{code:'SALE_NOT_CONFIRMED'})
  assert.equal(snapshots.length,0)
})
module.exports={fixture,scope}

test('cancellation preserves access to a saved original but cannot create an original for a cancelled sale',async()=>{
  const {db,sale,snapshots}=fixture()
  const original=await prepareSaleSnapshot(db,scope,{saleId:sale.id})
  sale.status.name='Cancelada'
  const copy=await prepareSaleSnapshot(db,scope,{saleId:sale.id})
  assert.equal(copy.id,original.id);assert.equal(snapshots.length,1)
  const uncaptured=fixture();uncaptured.sale.status.name='Cancelada'
  await assert.rejects(prepareSaleSnapshot(uncaptured.db,scope,{saleId:uncaptured.sale.id}),{code:'SALE_NOT_CONFIRMED'})
  assert.equal(uncaptured.snapshots.length,0)
})

for(const value of [undefined,'false'])test(`confirmed sale uses system defaults without an activation flag (${value})`,async()=>{
  const {db,sale}=fixture()
  db.state.settings=db.state.settings.filter(s=>s.key!=='invoices.templates_enabled')
  if(value)db.state.settings.push({company_id:companyId,key:'invoices.templates_enabled',value})
  const snapshot=await prepareSaleSnapshot(db,scope,{saleId:sale.id})
  assert.equal(snapshot.profiles.RECEIPT_80.rendererVersion,'INVOICE_BLOCKS_V2')
  assert.equal(snapshot.profiles.LETTER.design.base.version,2)
  assert.equal(snapshot.profiles.A4.templateVersionId,'44444444-4444-4444-8444-444444444444')
})
