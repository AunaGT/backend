const test = require('node:test')
const assert = require('node:assert/strict')
const { withMocks, jsonResponse } = require('./helpers/reportHarness.cjs')
const { selectLines } = require('../src/modules/orders/fulfillment')
const { partialLineTotal, pendingLineQty } = require('../src/services/commercialDocumentFulfillment')

function commercialStore() {
  const product = { id: 'P', company_id: 'A', name: 'Tornillo', kind: 'STANDARD', deleted: false, available_for_sale: true,
    unit_metadata_version:2,base_unit_id:'U', unit_revision: 2, quantity_decimals: 0, price: '2', price_wholesale: '1.5', cost: '0.123456789012' }
  const unit = { id: 'U', company_id: 'A', code: 'UNIT', name: 'Unidad', label: 'ud' }
  const box = { id: 'BOX', product_id: 'P', company_id: 'A', active: true, version: 1, name: 'Caja', label: 'caja',
    quantity_decimals: 0, factor: '24', sale_enabled: true, price: '40', price_wholesale: '30' }
  const tx = { $executeRaw: async () => 1, systemSetting: { findUnique: async () => ({key:'inventory_units_enabled',value:'true'}) },
    product: { findMany: async () => [product], findFirst: async () => product }, measureUnit: { findFirst: async () => unit, findMany:async()=>[unit] },
    productPresentation: { findFirst: async ({where}) => where.id === box.id && box.active ? box : null, findMany:async()=>box.active?[box]:[] } }
  return {tx,product,box}
}

test('commercial lines keep box and unit prices separate while carrying a single base stock dimension', async () => {
  const { resolveCommercialLines } = require('../src/services/units/saleLines')
  const { tx } = commercialStore()
  const lines = await resolveCommercialLines(tx, {companyId:'A',branchId:'B',actorId:'U',permissions:['sales.create']},
    [{product_id:'P',qty:'1',presentation_id:'BOX',unit_revision:2},{product_id:'P',qty:'2',presentation_id:null,unit_revision:2}], {tier:'WHOLESALE'})
  assert.deepEqual(lines.map(l=>[l.qty,l.base_qty,l.unit_price,l.line_total,l.unit_cost,l.base_unit_cost]),
    [['1','24','30','30.00','2.962962936288','0.123456789012'],['2','2','1.5','3.00','0.123456789012','0.123456789012']])
  assert.equal(lines[0].unit_label,'caja')
})

test('POS rejects an old cached configured product before stock or history writes', async () => {
  const {tx}=commercialStore()
  Object.assign(tx,{branch:{findUnique:async()=>({id:'B'})},cashRegister:{findFirst:async()=>({id:'C'})},
    cashRegisterSession:{findFirst:async()=>({id:'CS',opened_by_id:'U'})},$transaction:async run=>run(tx)})
  const bom=require.resolve('../src/services/bomStock')
  await withMocks({[require.resolve('../src/models/prisma')]:{prisma:tx,prismaTransaction:tx},[bom]:{...require(bom),
    getAvailabilityBatchWithKits:async()=>{throw Error('Stock boundary reached before revision validation')}}},require.resolve('../src/modules/sales/controller'),async controller=>{
    await assert.rejects(controller.create({companyId:'A',branchId:'B',user:{sub:'U',permissions:['sales.create']},
      body:{items:[{product_id:'P',qty:'1'}],payment_method_id:1,cash_register_id:'C'}},jsonResponse(),e=>{throw e}),e=>e.code==='UNIT_REVISION_CONFLICT')
  })
})

for(const moduleName of ['orders','quotes'])test(`${moduleName} creation requires the current advanced revision rather than treating a box as one base unit`,async()=>{
  const {tx}=commercialStore();tx.$transaction=async run=>run(tx)
  tx.systemSetting.findMany=async()=>[];tx.branch={findUnique:async()=>({id:'B'})}
  tx.commercialDocument={create:async()=>{throw Error('Document write reached before revision validation')}}
  const payments=require.resolve('../src/services/commercialPayment')
  await withMocks({[require.resolve('../src/models/prisma')]:{prisma:tx,prismaTransaction:tx},
    [require.resolve('../src/services/referenceGenerator')]:{nextDocumentReference:async()=> 'REF'},
    [require.resolve('../src/services/stockAvailability')]:{assertLinesAvailable:async()=>{},reserveForDocument:async()=>{},releaseByDocument:async()=>{}},
    [payments]:{...require(payments),documentPaymentTerms:async()=>({payment_condition:'CASH',credit_days:null})}},
  require.resolve(`../src/modules/${moduleName}/controller`),async controller=>{
    await assert.rejects(controller.create({companyId:'A',branchId:'B',user:{sub:'U',permissions:[`${moduleName}.create`]},body:{items:[{product_id:'P',qty:'1'}]}},
      jsonResponse(),e=>{throw e}),e=>e.code==='UNIT_REVISION_CONFLICT')
  })
})

test('approved commercial lines retain box24 and its price after the live presentation is archived', async () => {
  const { resolveCommercialLines } = require('../src/services/units/saleLines')
  const {tx,box,product} = commercialStore(), scope={companyId:'A',branchId:'B',permissions:['quotes.create']}
  const raw=[{product_id:'P',qty:'1',presentation_id:'BOX',unit_revision:2}]
  const [original]=await resolveCommercialLines(tx,scope,raw)
  box.active=false;box.factor='12';box.price='20';product.price='500000000'
  const [saved]=await resolveCommercialLines(tx,scope,[{...original,id:'L'}],{approved:true})
  assert.equal(saved.base_qty,'24');assert.equal(saved.unit_price,'40');assert.equal(saved.line_total,'40.00')
  await assert.rejects(resolveCommercialLines(tx,{...scope,permissions:[]},[{...original,id:'L'}],{approved:true}),e=>e.status===403)
})

test('commercial resolution rejects an old cached line and browser supplied conversion authority', async () => {
  const { resolveCommercialLines } = require('../src/services/units/saleLines')
  const {tx}=commercialStore(),scope={companyId:'A',branchId:'B',permissions:['sales.create']}
  await assert.rejects(resolveCommercialLines(tx,scope,[{product_id:'P',qty:'1'}]),e=>e.code==='UNIT_REVISION_CONFLICT')
  await assert.rejects(resolveCommercialLines(tx,scope,[{product_id:'P',qty:'1',unit_revision:2,base_qty:'1'}]),e=>e.status===400)
})

test('internal source authorization honors existing return and Agenda roles without granting ordinary sale authority',async()=>{
  const {resolveUnitLine}=require('../src/modules/inventory/units'),{tx,product}=commercialStore()
  const input={qty:'1',presentation_id:null,unit_revision:2},base={companyId:'A',branchId:'B'}
  assert.equal((await resolveUnitLine(tx,{...base,permissions:['returns.manage']},product,input,{authorization:'RETURN_REPLACEMENT'})).base_qty,'1')
  assert.equal((await resolveUnitLine(tx,{...base,permissions:['appointments.create','products.view']},product,input,{authorization:'APPOINTMENT_SOURCE'})).base_qty,'1')
  await assert.rejects(resolveUnitLine(tx,{...base,permissions:['returns.view']},product,input,{authorization:'RETURN_REPLACEMENT'}),e=>e.status===403)
  await assert.rejects(resolveUnitLine(tx,{...base,permissions:['appointments.create']},product,input,{authorization:'APPOINTMENT_SOURCE'}),e=>e.status===403)
  await assert.rejects(resolveUnitLine(tx,{...base,permissions:['returns.manage']},product,input),e=>e.status===403)
  for(const forged of [{authorization:'RETURN_REPLACEMENT'},{frozen_unit_price:'0.01'}])await assert.rejects(resolveUnitLine(tx,{...base,permissions:['sales.create']},product,{...input,...forged}),e=>e.status===400)
})

test('an approved original rounding retains its accepted base while arbitrary new snapshot quantities require acceptance',async()=>{
  const {resolveCommercialLines}=require('../src/services/units/saleLines'),{resolveUnitLine}=require('../src/modules/inventory/units')
  const {tx,product,box}=commercialStore();product.quantity_decimals=6;box.factor='0.45359237';box.price=null
  const scope={companyId:'A',branchId:'B',permissions:['quotes.create']}
  const [original]=await resolveCommercialLines(tx,scope,[{product_id:'P',qty:'1',presentation_id:'BOX',unit_revision:2,accept_rounding:true}])
  const [saved]=await resolveCommercialLines(tx,scope,[original],{approved:true})
  assert.equal(saved.base_qty,'0.453592');assert.equal(saved.unit_snapshot.roundingDelta,'-0.00000037')
  await assert.rejects(resolveUnitLine(tx,scope,product,{qty:'2'},{snapshot:original.unit_snapshot,frozen_unit_price:original.unit_price}),e=>e.code==='QUANTITY_ROUNDING_REQUIRED')
})

test('persisting a sale preserves exact derived price, base cost and immutable unit metadata',async()=>{
  const {insertSaleRecord}=require('../src/modules/sales/application')
  const {resolveCommercialLines}=require('../src/services/units/saleLines')
  const {tx,product,box}=commercialStore()
  product.quantity_decimals=6;product.price='1.23';box.factor='0.0000001';box.price=null;box.quantity_decimals=0
  const items=await resolveCommercialLines(tx,{companyId:'A',branchId:'B',permissions:['sales.create']},[{product_id:'P',qty:'10000000',presentation_id:'BOX',unit_revision:2}])
  let stored
  tx.sale={create:async({data})=>({id:'V',...data})};tx.saleItem={createMany:async({data})=>{stored=data}}
  await insertSaleRecord(tx,{saleData:{items:1,total:'1.23',unit_metadata_version:2},items,userId:'U'})
  assert.equal(stored[0].price,'0.000000123');assert.equal(stored[0].base_qty,'1');assert.equal(stored[0].base_unit_cost,'0.123456789012')
  assert.equal(stored[0].unit_snapshot.presentation.id,'BOX')
})

const box7 = { id: 'L', product_id: 'P', item_kind: 'STANDARD', qty: '1', base_qty: '7', base_fulfilled: '0', base_invoiced: '0',
  qty_fulfilled: '0', qty_invoiced: '0', quantity_decimals: 0, unit_price: '10', line_total: '10.00', unit_metadata_version: 2,
  unit_snapshot: { version: 2, baseUnit: { id: 'U', code: 'UNIT', name: 'Unidad', label: 'ud', decimals: 0 },
    presentation: { id: 'BOX', version: 1, name: 'Caja 7', label: 'caja', decimals: 0 }, factor: '7', roundingDelta: '0' } }

test('a box of seven can be delivered as three then four base units without a rounded seventh', () => {
  const first = selectLines([box7], [{ line_id: 'L', qty: '3', presentation_id: null }])[0]
  assert.equal(String(first.base_qty), '3')
  assert.equal(String(first.qty), '3')
  assert.equal(first.unit_snapshot.presentation, null)
  assert.equal(partialLineTotal(box7, '3', '0').toFixed(2), '4.29')
  const remaining = { ...box7, base_fulfilled: '3' }
  assert.equal(pendingLineQty(remaining).toFixed(), '4')
  const last = selectLines([remaining], [{ line_id: 'L', qty: '4', presentation_id: null }])[0]
  assert.equal(String(last.base_qty), '4')
  assert.equal(partialLineTotal(box7, '4', '3').toFixed(2), '5.71')
  assert.throws(() => selectLines([remaining], [{ line_id: 'L', qty: '1' }]), /pendiente/)
  assert.throws(() => selectLines([remaining], [{ line_id: 'L', qty: '1', presentation_id: 'NEW' }]))
})

test('v2 invoice availability uses base delivered and invoiced accumulators', () => {
  const orderLine = { ...box7, base_fulfilled: '7', base_invoiced: '3', qty_fulfilled: '1', qty_invoiced: '0.428571' }
  const line = selectLines([orderLine], [{ line_id: 'L', qty: '4', presentation_id: null }], true)[0]
  assert.equal(String(line.base_qty), '4')
  assert.throws(() => selectLines([orderLine], [{ line_id: 'L', qty: '5', presentation_id: null }], true), /pendiente/)
  assert.throws(()=>selectLines([{...box7,base_fulfilled:'3'}],[{line_id:'L',qty:'1'}],true),/pendiente/)
})

test('default fulfillment of the remaining box balance creates its own exact base-unit line',()=>{
  const {resolveFulfillmentLines}=require('../src/services/commercialDocumentFulfillment')
  const line={id:'L',product_id:'P',qty:'1',base_qty:'7',base_fulfilled:'3',unit_price:'10',line_total:'10',unit_metadata_version:2,
    unit_snapshot:{version:2,baseUnit:{id:'U',code:'UNIT',label:'ud',decimals:0},presentation:{id:'BOX',label:'caja',decimals:0},factor:'7',roundingDelta:'0'}}
  const [remaining]=resolveFulfillmentLines([line])
  assert.equal(String(remaining.qty),'4');assert.equal(String(remaining.base_qty),'4')
  assert.equal(remaining.unit_snapshot.presentation,null)
})

test('order invoicing refuses a linked draft whose frozen base quantity was changed',async()=>{
  const {Prisma}=require('@prisma/client'),n=value=>new Prisma.Decimal(value),{invoice}=require('../src/modules/orders/fulfillment')
  const line={...box7,qty:n(1),unit_price:n(10),line_total:n(10),base_fulfilled:'7',item_kind:'STANDARD'}
  const order={id:'O',branch_id:'B',fulfillment_mode:'SEPARATE',status:'FULFILLED',lines:[line],total:n(10)}
  const draft={id:'V',status:{name:'Borrador'},version:1,total:n(10),sale_items:[{...line,id:1,qty:n(1),price:n(10),net_total:n(10),base_qty:'6'}]}
  let confirmed=false
  const tx={$queryRaw:async()=>[{id:'O'}],$executeRaw:async()=>0,commercialDocument:{findUnique:async()=>order},appointmentEngagement:{findFirst:async()=>null},sale:{findFirst:async({where})=>where.id==='V'?draft:null,update:async()=>{confirmed=true;throw Object.assign(new Error('Draft confirmed before unit validation'),{status:500})}},
    companyPaymentMethod:{findFirst:async()=>({enabled:true,payment_method:{id:1,is_credit:false}})},saleStatus:{findFirst:async()=>({id:1})},branch:{findUnique:async()=>({id:'B'})},
    orderDeliveryLine:{findMany:async()=>[{id:'D',document_line_id:'L',base_qty:'7',base_unit_cost:'1',unit_metadata_version:2,physical_snapshot:{version:1,entries:[]}}]}}
  const req={params:{id:'O'},companyId:'A',branchId:'B',user:{sub:'U'},body:{request_key:'b73abc4a-041e-4ce0-baa6-d38cc18aaeee',payment_method_id:1,lines:[{line_id:'L',qty:'1'}]}}
  await assert.rejects(invoice(tx,req,()=>{}, {kind:'EXISTING_RECEIPTS',draftSaleId:'V',engagementId:'E'}),e=>e.status===409)
  assert.equal(confirmed,false)
})

test('order confirmation reloads its state under the document lock before reserving frozen units',async()=>{
  let reserved=false
  const initial={id:'O',branch_id:'B',status:'DRAFT',lines:[box7]}
  const tx={$queryRaw:async()=>[{id:'O'}],commercialDocument:{findUnique:async()=>({...initial,status:'CONFIRMED'}),findFirst:async()=>({...initial,status:'CONFIRMED'}),update:async()=>{}},$transaction:async run=>run(tx)}
  const db={...tx,commercialDocument:{findFirst:async()=>initial}}
  const stock=require.resolve('../src/services/stockAvailability')
  await withMocks({[require.resolve('../src/models/prisma')]:{prisma:db,prismaTransaction:tx},[stock]:{...require(stock),assertLinesAvailable:async()=>{},reserveForDocument:async()=>{reserved=true}}},require.resolve('../src/modules/orders/controller'),async controller=>{
    const res=jsonResponse();let failure
    await controller.confirm({companyId:'A',branchId:'B',user:{sub:'U'},params:{id:'O'}},res,e=>{failure=e})
    assert.equal(reserved,false)
    assert.ok(failure?.status===409||res.statusCode===400)
  })
})

test('reservation consumption uses base progress and frozen components after a BOM change',async()=>{
  const {consumePartialByDocument}=require('../src/services/stockAvailability')
  const line={...box7,base_fulfilled:'3',qty_fulfilled:'0.428571'}
  const reservation={id:'R',product_id:'COMPONENT',qty:'0.4',document_line_id:'L'}
  let increment,status
  const tx={commercialDocumentLine:{findUnique:async()=>line,update:async({data})=>{increment=data}},
    stockReservation:{findMany:async()=>[reservation],update:async({data})=>{status=data.status}}}
  await consumePartialByDocument(tx,'O',[{line_id:'L',qty:'4',base_qty:'4'}],{companyId:'A'})
  assert.equal(status,'CONSUMED');assert.equal(String(increment.base_fulfilled.increment),'4')
})

test('delivery requirements come from the frozen reservation and accepted base balance',async()=>{
  const {reservationStockMaps}=require('../src/services/units/commercialPhysical')
  const tx={stockReservation:{findMany:async()=>[{product_id:'COMPONENT',qty:'0.4'}]},product:{findMany:async()=>[{id:'COMPONENT',kind:'STANDARD',quantity_decimals:2}]}}
  const [map]=await reservationStockMaps(tx,'O',[{line:{...box7,base_fulfilled:'3'},line_id:'L',qty:'4',base_qty:'4'}])
  assert.deepEqual([...map],[['COMPONENT','0.4']])
})

for(const [agreedTotal,first,last]of [['10',4.29,5.71],['9',3.86,5.14]])test(`invoicing three plus four preserves net agreement ${agreedTotal}, physical attribution and exact cost`,async()=>{
  const {invoice}=require('../src/modules/orders/fulfillment')
  const source={...box7,base_fulfilled:'7',qty_fulfilled:'1'}
  const delivered={id:'D',document_line_id:'L',qty:'1',qty_invoiced:'0',base_qty:'7',base_invoiced:'0',unit_metadata_version:2,
    base_unit_cost:'2.123456789012',unit_cost:'14.864197523084',physical_snapshot:{version:1,entries:[{product_id:'P',location_id:'LOCATION',base_qty:'7',base_unit_cost:'2.123456789012',unit_snapshot:{version:1},lots:[]}]}}
  const order={id:'O',branch_id:'B',fulfillment_mode:'SEPARATE',status:'FULFILLED',lines:[source],total:agreedTotal}
  const saved=[]
  const tx={$queryRaw:async()=>[{id:'O'}],$executeRaw:async()=>0,commercialDocument:{findUnique:async()=>order},appointmentEngagement:{findFirst:async()=>null},
    sale:{findFirst:async()=>null,create:async({data})=>{saved.push(data);return{id:'V',...data}}},
    companyPaymentMethod:{findFirst:async()=>({enabled:true,payment_method:{id:1,is_credit:false}})},saleStatus:{findFirst:async()=>({id:1})},branch:{findUnique:async()=>({id:'B',code:'A',seq:1})},
    orderDeliveryLine:{findMany:async()=>[delivered],update:async({data})=>{for(const k of ['base_invoiced','qty_invoiced'])if(data[k])delivered[k]=data[k].increment?String(new (require('@prisma/client').Prisma.Decimal)(delivered[k]).add(data[k].increment)):String(data[k])}},
    commercialDocumentLine:{update:async({data})=>{for(const k of ['base_invoiced','qty_invoiced'])if(data[k])source[k]=data[k].increment?String(new (require('@prisma/client').Prisma.Decimal)(source[k]).add(data[k].increment)):String(data[k])}}}
  const req={params:{id:'O'},companyId:'A',branchId:'B',user:{sub:'U',permissions:['sales.create']},body:{request_key:'b73abc4a-041e-4ce0-baa6-d38cc18aaeee',payment_method_id:1,lines:[{line_id:'L',qty:'3',presentation_id:null}]}}
  await invoice(tx,req,async()=> 'CS')
  assert.equal(saved[0].total,first);assert.equal(saved[0].items,1)
  assert.equal(saved[0].sale_items.create[0].unit_snapshot.presentation,null)
  assert.equal(String(saved[0].sale_items.create[0].qty),'3');assert.equal(String(saved[0].sale_items.create[0].base_qty),'3')
  assert.equal(saved[0].sale_items.create[0].base_unit_cost,'2.123456789012')
  assert.equal(saved[0].sale_items.create[0].physical_snapshot.entries[0].base_qty,'3')
  req.body.lines[0].qty='4'
  await invoice(tx,req,async()=> 'CS')
  assert.equal(saved[1].total,last);assert.equal(source.base_invoiced,'7');assert.equal(delivered.base_invoiced,'7')
})

test('the real POS transaction deducts aggregate base stock once and persists actual per-line lots',async()=>{
  const {commerceHarness}=require('./helpers/unitsCommerceHarness.cjs')
  const product={id:'P',company_id:'A',name:'Producto',kind:'STANDARD',deleted:false,available_for_sale:true,quantity_decimals:0,unit_metadata_version:2,base_unit_id:'U',unit_revision:2,price:'2',cost:'1.25',tracks_expiry:true}
  const f=commerceHarness({products:[product],stock:{P:'10'},locations:{'P|L1':'3','P|L2':'7'},units:[{id:'U',company_id:'A',code:'UNIT',name:'Unidad',label:'ud'}],
    presentations:[{id:'BOX',company_id:'A',product_id:'P',version:1,name:'Caja',label:'caja',factor:'7',quantity_decimals:0,active:true,sale_enabled:true,price:'10'}],
    lots:[{id:'LTA',product_id:'P',branch_id:'B',location_id:'L1',qty_remaining:'3',qty_received:'3',lot_code:'A',unit_cost:'1',received_at:new Date('2026-01-01'),expiry_date:null},
      {id:'LTB',product_id:'P',branch_id:'B',location_id:'L2',qty_remaining:'7',qty_received:'7',lot_code:'B',unit_cost:'2',received_at:new Date('2026-01-02'),expiry_date:null}]})
  const ref=require.resolve('../src/services/referenceGenerator')
  await withMocks({[require.resolve('../src/models/prisma')]:{prisma:f.tx,prismaTransaction:f.tx},[ref]:{nextDocumentReference:async()=> 'V-A-1'}},require.resolve('../src/modules/sales/controller'),async controller=>{
    const response=jsonResponse()
    await controller.create({companyId:'A',branchId:'B',user:{sub:'U',permissions:['sales.create']},body:{payment_method_id:1,cash_register_id:'C',items:[
      {product_id:'P',qty:'1',presentation_id:'BOX',unit_revision:2},{product_id:'P',qty:'1',presentation_id:null,unit_revision:2}]}},response,e=>{throw e})
    assert.equal(response.statusCode,201)
  })
  assert.equal(f.state.stock.P,'2');assert.equal(f.state.sales[0].items,2);assert.equal(f.state.sales[0].total,12)
  assert.deepEqual(f.state.saleItems.map(line=>[line.qty,line.base_qty,line.price,line.unit_cost]),[['1','7','10','8.75'],['1','1','2','1.25']])
  assert.deepEqual(f.state.saleItems.map(line=>line.physical_snapshot.entries.map(e=>[e.location_id,e.base_qty,e.lots.map(l=>[l.lot_code,l.qty])])),[
    [['L1','3',[['A','3']]],['L2','4',[['B','4']]]],[['L2','1',[['B','1']]]]])
  assert.deepEqual(f.state.lots.map(l=>l.qty_remaining),['0','2'])
  assert.deepEqual(f.state.outbox,[{sale_id:f.state.sales[0].id,company_id:'A',branch_id:'B',product_ids:['P']}])
})

test('accepted quote to engagement and draft retains six-place goods and eighteen-place derived price',async()=>{
  const {Prisma}=require('@prisma/client'),decimal=value=>new Prisma.Decimal(value)
  const id='00000000-0000-4000-8000-000000000001'
  const physical={...box7,id:'QL',sort_order:0,qty:decimal('10000000'),base_qty:decimal('1'),unit_price:decimal('0.000000123'),line_total:decimal('1.23'),item_name:'Micro',unit_label:'micro',quantity_decimals:0,
    unit_snapshot:{...box7.unit_snapshot,factor:'0.0000001',baseUnit:{...box7.unit_snapshot.baseUnit,decimals:6}}}
  const service={id:'QS',sort_order:1,product_id:'S',item_kind:'SERVICE',item_name:'Consulta',unit_label:'Hora',quantity_decimals:2,qty:decimal('1.25'),unit_price:decimal('10'),line_total:decimal('12.50')}
  const quote={id,branch_id:'B',customer_contact_id:'CUSTOMER',status:'ACCEPTED',customerContact:{company_id:'A',party_type:'CUSTOMER',name:'Cliente',deleted:false},convertedChildren:[],lines:[physical,service],total:decimal('13.73'),subtotal:decimal('13.73')}
  let engagementData,draftItems
  const tx={$executeRaw:async()=>0,$queryRaw:async()=>[{id}],companyModule:{findMany:async()=>[{module_code:'quotes',enabled:true}]},systemSetting:{findUnique:async()=>({value:'GTQ'})},commercialDocument:{findFirst:async()=>quote},
    appointmentEngagement:{create:async({data})=>{engagementData=data;return{id:'E',...data,lines:data.lines.create}},findFirst:async()=>null},appointmentEngagementHistory:{create:async()=>{}},
    sale:{findFirst:async()=>null,create:async({data})=>({id:'V',...data})},saleItem:{createMany:async({data})=>{draftItems=data}},
    product:{findMany:async()=>[{id:'P',kind:'STANDARD',cost:'5'},{id:'S',kind:'SERVICE',cost:'0'}]},branch:{findFirst:async()=>({id:'B',code:'A',seq:1})},saleStatus:{findUnique:async()=>({id:1})},saleHistory:{create:async()=>{}}}
  const scope={companyId:'A',branchId:'B',userId:'U',isAdmin:true,permissions:[]}
  const {loadQuoteSource}=require('../src/modules/quotes')
  const source=await loadQuoteSource(tx,scope,id)
  assert.equal(source.lines[0].unitPrice,'0.000000123');assert.equal(source.lines[0].baseQty,'1')
  const row=await require('../src/modules/appointments/engagementRecords').createEngagementRecord(tx,scope,{source,quoteId:id,requestKey:'NEW',inputHash:'HASH'})
  assert.equal(engagementData.lines.create[0].unit_metadata_version,2)
  assert.equal(String(engagementData.lines.create[0].base_qty),'1')
  await require('../src/modules/sales/engagementSale').ensureEngagementDraft(tx,scope,{source:{...row,company_id:'A',branch_id:'B',customer:{name:'Cliente'}}})
  assert.equal(draftItems[0].price,'0.000000123');assert.equal(draftItems[0].base_qty,'1');assert.equal(draftItems[0].unit_label,'micro')
})

test('actual accepted quote conversion and confirmation reserve its original box24 after live archival',async()=>{
  const {commerceHarness}=require('./helpers/unitsCommerceHarness.cjs')
  const id='00000000-0000-4000-8000-000000000001'
  const f=commerceHarness({products:[{id:'P',company_id:'A',kind:'STANDARD',name:'Producto',unit_metadata_version:2,base_unit_id:'U',quantity_decimals:0,cost:'1',deleted:false,available_for_sale:true}],stock:{P:'30'},locations:{'P|L':'30'}})
  f.state.documents.push({id,reference:'Q-1',doc_type:'QUOTE',status:'ACCEPTED',branch_id:'B',convertedChildren:[],total:'40',subtotal:'40'})
  f.state.documentLines.push({...box7,id:'QL',document_id:id,base_qty:'24',unit_price:'40',line_total:'40',unit_label:'caja',unit_snapshot:{...box7.unit_snapshot,factor:'24'}})
  const models={[require.resolve('../src/models/prisma')]:{prisma:f.tx,prismaTransaction:f.tx}}
  let order
  await withMocks(models,require.resolve('../src/modules/quotes/controller'),async controller=>{
    const res=jsonResponse();await controller.convertToOrder({companyId:'A',branchId:'B',user:{sub:'U'},params:{id}},res,e=>{throw e});order=res.body
  })
  assert.equal(order.lines[0].base_qty,'24');assert.equal(order.lines[0].unit_price,'40');assert.equal(order.lines[0].unit_snapshot.factor,'24')
  await withMocks(models,require.resolve('../src/modules/orders/controller'),async controller=>{
    await controller.confirm({companyId:'A',branchId:'B',user:{sub:'U'},params:{id:order.reference}},jsonResponse(),e=>{throw e})
  })
  assert.equal(f.state.documents[1].status,'CONFIRMED')
  assert.deepEqual(f.state.reservations.map(row=>[row.product_id,String(row.qty)]),[['P','24']]);assert.equal(f.state.stock.P,'30')
})

test('actual Agenda confirmation dispatches measured goods once without using current prices or dispatching services',async()=>{
  const {commerceHarness}=require('./helpers/unitsCommerceHarness.cjs'),{Prisma}=require('@prisma/client')
  const f=commerceHarness({products:[{id:'P',company_id:'A',kind:'STANDARD',name:'Micro',unit_metadata_version:2,base_unit_id:'U',quantity_decimals:6,cost:'3',price:'9999999999',available_for_sale:true,deleted:false},
    {id:'S',company_id:'A',kind:'SERVICE',name:'Consulta',cost:'999',price:'9999999999',available_for_sale:true,deleted:false}],stock:{P:'2',S:'0'},locations:{'P|L':'2'},units:[{id:'U',code:'UNIT',name:'Unidad',label:'ud'}]})
  const unit={...box7.unit_snapshot,factor:'0.0000001',baseUnit:{...box7.unit_snapshot.baseUnit,decimals:6}}
  const source={id:'E',company_id:'A',branch_id:'B',customer_id:'C',customer:{name:'Cliente'},agreed_total:'13.73',commercial_snapshot:{},lines:[
    {product_id:'P',sort_order:0,item_name:'Micro',item_kind:'STANDARD',qty:'10000000',unit_price:'0.000000123',line_total:'1.23',unit_label:'micro',quantity_decimals:0,unit_metadata_version:2,base_qty:'1',unit_snapshot:unit},
    {product_id:'S',sort_order:1,item_name:'Consulta',item_kind:'SERVICE',qty:'1.25',unit_price:'10',line_total:'12.50',unit_label:'Hora',quantity_decimals:2}]}
  const api=require('../src/modules/sales/engagementSale'),scope={companyId:'A',branchId:'B',userId:'U'}
  f.tx.branch.findFirst=async()=>({id:'B',code:'A',seq:1});f.tx.saleStatus.findUnique=async()=>({id:3});f.tx.saleHistory={create:async()=>{}}
  const find=f.tx.sale.findFirst
  f.tx.sale.findFirst=async args=>{const row=await find(args);return row&&{...row,total:new Prisma.Decimal(row.total),status:{name:row.status_id===3?'Borrador':'Completada'},sale_items:row.sale_items.map(line=>({...line,qty:new Prisma.Decimal(line.qty),price:new Prisma.Decimal(line.price),net_total:new Prisma.Decimal(line.net_total)}))}}
  const draft=await api.ensureEngagementDraft(f.tx,scope,{source})
  await api.confirmEngagementDraft(f.tx,scope,{source,draftSaleId:draft.saleId,idempotencyKey:'once',settlement:{kind:'EXISTING_RECEIPTS',issuedAt:new Date(),paymentMethodId:1}})
  assert.equal(f.state.stock.P,'1');assert.equal(f.state.stock.S,'0');assert.equal(f.state.sales[0].items,2)
  assert.equal(f.state.saleItems[0].price,'0.000000123');assert.equal(f.state.saleItems[0].physical_snapshot.entries[0].base_qty,'1')
  assert.deepEqual(f.state.saleItems[1].physical_snapshot.entries,[])
})

test('real order delivery of three plus four and reversal preserve base balances and original lots',async()=>{
  const {commerceHarness}=require('./helpers/unitsCommerceHarness.cjs'),{reserveForDocument}=require('../src/services/stockAvailability')
  const {deliver,reverseDelivery}=require('../src/modules/orders/fulfillment')
  const f=commerceHarness({products:[{id:'P',company_id:'A',kind:'STANDARD',name:'Producto',unit_metadata_version:2,base_unit_id:'U',quantity_decimals:0,cost:'1.25',deleted:false,available_for_sale:true,tracks_expiry:true}],
    stock:{P:'10'},locations:{'P|L1':'3','P|L2':'7'},units:[{id:'U',code:'UNIT',name:'Unidad',label:'ud'}],
    lots:[{id:'A',product_id:'P',branch_id:'B',location_id:'L1',qty_received:'3',qty_remaining:'3',lot_code:'A',unit_cost:'1',received_at:new Date('2026-01-01'),expiry_date:null},
      {id:'B',product_id:'P',branch_id:'B',location_id:'L2',qty_received:'7',qty_remaining:'7',lot_code:'B',unit_cost:'2',received_at:new Date('2026-01-02'),expiry_date:null}]})
  const line={...box7,document_id:'O'}
  f.state.documents.push({id:'O',branch_id:'B',fulfillment_mode:'SEPARATE',status:'CONFIRMED'});f.state.documentLines.push(line)
  await reserveForDocument(f.tx,{documentId:'O',documentLines:[line],branchId:'B',companyId:'A',createdBy:'U'})
  const req={companyId:'A',branchId:'B',params:{id:'O'},user:{sub:'U'},body:{request_key:'b73abc4a-041e-4ce0-baa6-d38cc18aaeee',lines:[{line_id:'L',qty:'3',presentation_id:null}]}}
  await f.tx.$transaction(tx=>deliver(tx,req))
  req.body.request_key='b73abc4a-041e-4ce0-baa6-d38cc18aaeed';req.body.lines[0].qty='4'
  await f.tx.$transaction(tx=>deliver(tx,req))
  assert.equal(f.state.stock.P,'3');assert.equal(f.state.documentLines[0].base_fulfilled,'7')
  assert.deepEqual(f.state.deliveryLines.map(line=>[line.qty,line.base_qty,line.unit_cost]),[['3','3','1.25'],['4','4','1.25']])
  req.params.deliveryId='D0'
  await f.tx.$transaction(tx=>reverseDelivery(tx,req))
  assert.equal(f.state.stock.P,'6');assert.equal(f.state.documentLines[0].base_fulfilled,'4')
  assert.deepEqual(f.state.lots.slice(2).map(lot=>[lot.location_id,String(lot.qty_remaining),lot.lot_code,lot.unit_cost]),[['L1','3','A','1']])
  assert.equal(f.state.reservations.filter(row=>row.status==='ACTIVE').reduce((sum,row)=>sum+Number(row.qty),0),3)
})

test('a service price edit loaded before first unit configuration cannot bypass the locked revision check', async () => {
  const legacy = { id: 'S', company_id: 'A', name: 'Consulta', kind: 'SERVICE', deleted: false,
    price: '10', service_unit_label: 'Hora', quantity_decimals: 2, unit_revision: 1, base_unit_id: null }
  const configured = { ...legacy, unit_metadata_version:2,base_unit_id:'H', unit_revision: 2 }
  let read = false
  let locked = false
  let writes = 0
  const db = {
    systemSetting: { findUnique: async ({ where }) => ({ key: where.company_id_key.key, value: 'true' }) },
    product: {
      findFirst: async () => { if (!read) { read = true; return legacy } assert.equal(locked, true); return configured },
      update: async () => { writes++; return configured },
    },
    $executeRaw: async (strings) => { if (String(strings).includes('FOR UPDATE')) locked = true },
    $transaction: async run => run(db),
  }
  await withMocks({ [require.resolve('../src/models/prisma')]: { prisma: db, prismaTransaction: db } },
    require.resolve('../src/modules/inventory/products.controller'), async controller => {
      await assert.rejects(controller.update({ companyId: 'A', branchId: 'B', params: { id: 'S' },
        user: { sub: 'U', permissions: ['products.edit'] }, body: { price: '11' } }, jsonResponse(), error => { throw error }),
      error => error.status === 409 && error.code === 'UNIT_REVISION_CONFLICT')
    })
  assert.equal(writes, 0)
})
