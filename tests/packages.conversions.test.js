const test=require('node:test'),assert=require('node:assert/strict')
const {randomUUID}=require('node:crypto')
const {Prisma}=require('@prisma/client')
const {agreementFixture}=require('./helpers/packageAgreementFixture')
const {quoteHarness}=require('./helpers/packageQuoteHarness')
const {manualHarness}=require('./helpers/manualSalesHarness.cjs')
const {withMocks}=require('./helpers/reportHarness.cjs')
const {id}=require('./helpers/packageFixtures')
const Packages=require('../src/services/commercialPackages')

test('quote to order preserves original package snapshot and component identities',async()=>quoteHarness(async f=>{
  const built=await Packages.buildPackageGroups(f.db,f.scope,[f.selection()],{allowIncomplete:true})
  f.setDocument({id:id(400),doc_type:'QUOTE',branch_id:f.scope.branchId,status:'ACCEPTED',integration_revision:f.revision,
    package_groups:built.groups,lines:built.lines,subtotal:built.subtotal,total:built.subtotal,discount_total:'0',convertedChildren:[],documentSales:[]})
  const {error,res}=await f.invoke('convertToOrder',{})
  assert.equal(error,undefined);assert.equal(res.statusCode,201)
  assert.deepEqual(res.body.package_groups,built.groups)
  assert.deepEqual(res.body.lines.map(l=>l.package_component_key),built.lines.map(l=>l.package_component_key))
  assert.equal(res.body.lines.length,3);assert.equal(res.body.total,'1599.00')
}))
test('approved unit resolver preserves separate groups even when they contain same product',async()=>{
  const f=await agreementFixture(),built=await Packages.buildPackageGroups(f.db,f.scope,[f.selection(),{...f.selection(),groupId:id(102)}],{allowIncomplete:true})
  const {resolveCommercialLines}=require('../src/services/units/saleLines')
  const resolved=await resolveCommercialLines(f.db,{...f.scope,isAdmin:true},built.lines,{approved:true})
  assert.equal(resolved.length,6);assert.equal(new Set(resolved.map(l=>l.package_component_key)).size,6)
  assert.deepEqual(resolved.map(l=>l.unit_snapshot),built.lines.map(l=>l.unit_snapshot))
  await assert.rejects(()=>resolveCommercialLines(f.db,{...f.scope,isAdmin:true},[built.lines[0]],{}),{status:400})
  await assert.rejects(()=>resolveCommercialLines(f.db,{...f.scope,isAdmin:true},[{product_id:id(21),qty:'1',approved:true}],{}),{status:400})
})
test('Agenda insertion freezes groups and source keys without creating resource or stock records',async()=>{
  const f=await agreementFixture(),built=await Packages.buildPackageGroups(f.db,f.scope,[f.selection()],{allowIncomplete:true})
  let saved
  f.db.appointmentEngagement={create:async({data})=>{saved=data;return{id:id(401),...data,lines:data.lines.create}}}
  f.db.appointmentEngagementHistory={create:async()=>({})}
  const source={customerId:id(402),currencyCode:'GTQ',total:built.subtotal,orders:[],packageGroups:built.groups,
    lines:built.lines.map((l,i)=>({id:id(410+i),productId:l.product_id,itemName:l.item_name,itemKind:l.item_kind,quantity:l.qty,
      unitLabel:l.unit_label,quantityDecimals:l.quantity_decimals,unitPrice:l.unit_price,lineTotal:l.line_total,sortOrder:i,
      unitMetadataVersion:l.unit_metadata_version,unitSnapshot:l.unit_snapshot,baseQty:l.base_qty,packageComponentKey:l.package_component_key}))}
  await require('../src/modules/appointments/engagementRecords').createEngagementRecord(f.db,{...f.scope,userId:f.scope.actorId},{source,quoteId:id(400),requestKey:randomUUID(),inputHash:'synthetic'})
  assert.deepEqual(saved.package_groups,built.groups);assert.deepEqual(saved.lines.create.map(l=>l.package_component_key),built.lines.map(l=>l.package_component_key))
  assert.ok(saved.lines.create.every(l=>l.unit_snapshot?.version===1))
})
test('fingerprint catches same-total product, unit or group changes and ignores object-key ordering',async()=>{
  const f=await agreementFixture(),built=await Packages.buildPackageGroups(f.db,f.scope,[f.selection()],{allowIncomplete:true})
  const fingerprint=Packages.packageSourceFingerprint(built.groups,built.lines)
  assert.match(fingerprint,/^[a-f0-9]{64}$/)
  const reordered=JSON.parse(JSON.stringify(built.groups,(k,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).reverse()):v))
  assert.equal(Packages.packageSourceFingerprint(reordered,built.lines),fingerprint)
  for(const mutate of [l=>{l.product_id=id(23)},l=>{l.unit_label='caja'},l=>{l.package_component_key=id(102)+':'+id(4)}]){
    const changed=structuredClone(built.lines);mutate(changed[1]);assert.notEqual(Packages.packageSourceFingerprint(built.groups,changed),fingerprint)
  }
  const copy=Packages.copyPackageGroups(built.groups);copy[0].name='Otro';assert.equal(built.groups[0].name,'Paquete de evento')
})
test('direct quote sale and confirmation retain original groups, net amounts and one stock effect',async()=>{
  const f=await agreementFixture(),h=manualHarness()
  Object.assign(h.scope,{...f.scope,userId:f.scope.actorId,isAdmin:true});h.customer.company_id=f.scope.companyId
  const built=await Packages.buildPackageGroups(f.db,f.scope,[f.selection()],{allowIncomplete:true})
  h.db.product=f.db.product;h.db.systemSetting={...f.db.systemSetting,findMany:h.db.systemSetting.findMany};h.db.companyModule=f.db.companyModule
  const quote={id:id(400),doc_type:'QUOTE',status:'ACCEPTED',branch_id:h.scope.branchId,customer_contact_id:h.customer.id,customer:h.customer.name,
    package_groups:built.groups,lines:built.lines,subtotal:'1599.00',discount_total:'0.00',total:'1599.00',documentSales:[],convertedChildren:[]}
  h.db.commercialDocument={findFirst:async()=>quote};h.db.$queryRaw=async()=>[{id:quote.id}]
  h.db.commercialDocumentSale={create:async({data})=>{quote.documentSales.push(data);return data}}
  const find=h.db.sale.findFirst;h.db.sale.findFirst=async q=>{const row=await find(q);return row&&{...row,orderLink:{document:quote}}}
  const mocks={...h.mocks,[require.resolve('../src/services/stockAvailability')]:{assertLinesAvailable:async()=>{},consumeByDocument:async()=>{}}}
  await withMocks(mocks,require.resolve('../src/modules/quotes/saleDraft'),async api=>{
    const draft=await api.createQuoteSaleDraft(h.db,h.scope,quote.id)
    assert.deepEqual(h.state.sales[0].package_groups,built.groups)
    assert.deepEqual(h.state.items.map(l=>l.package_component_key),built.lines.map(l=>l.package_component_key));assert.deepEqual(h.state.effects,[])
    await withMocks(mocks,require.resolve('../src/modules/sales/manualSales'),async manual=>{
      const request={expectedVersion:1,idempotencyKey:randomUUID(),dueDate:'2099-01-01'}
      const originalKey=h.state.items[1].package_component_key
      h.state.items[1].package_component_key=id(102)+':'+id(4)
      await assert.rejects(manual.confirmManualSale(h.db,h.scope,draft.id,request),{code:'SOURCE_REVIEW_REQUIRED'})
      assert.deepEqual(h.state.effects,[]);h.state.items[1].package_component_key=originalKey
      await manual.confirmManualSale(h.db,h.scope,draft.id,request)
      await manual.confirmManualSale(h.db,h.scope,draft.id,request)
      assert.deepEqual(h.state.effects,['stock','accounting'])
    })
  })
})
