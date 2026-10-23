const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto')
const {manualHarness}=require('./helpers/manualSalesHarness.cjs'),{withMocks}=require('./helpers/reportHarness.cjs')
const target=require.resolve('../src/modules/quotes')+'/../saleDraft.js'
function harness(){
 const h=manualHarness();h.scope.permissions.push('quotes.manage','quotes.view')
 const quote={id:randomUUID(),branch_id:h.scope.branchId,doc_type:'QUOTE',status:'ACCEPTED',reference:'C-1',customer_contact_id:h.customer.id,customer:h.customer.name,customer_nit:'CF',is_final_consumer:true,subtotal:'25.62',discount_total:'5.12',total:'20.50',convertedChildren:[],quoted_engagement:null,documentSales:[],lines:[1,2].map(i=>({id:randomUUID(),product_id:h.product.id,qty:'1.25',unit_price:'10.25',line_total:'12.81',item_name:'Precio aceptado',item_kind:'SERVICE',unit_label:'Hora',quantity_decimals:2,sort_order:i}))}
 h.quote=quote;h.db.companyModule={findMany:async()=>[]};h.db.$queryRaw=async()=>[{id:quote.id}]
 h.db.commercialDocument={findFirst:async({where})=>where.id===quote.id&&where.branch_id===h.scope.branchId&&where.branch.company_id===h.scope.companyId?quote:null}
 h.db.commercialDocumentSale={create:async({data})=>{quote.documentSales.push({...data,sale:h.state.sales.find(s=>s.id===data.sale_id)});return data}}
 const find=h.db.sale.findFirst;h.db.sale.findFirst=async args=>{const row=await find(args);return row&&{...row,orderLink:quote.documentSales.some(l=>l.sale_id===row.id)?{document:quote}:null}}
 h.mocks[require.resolve('../src/modules/quotes/index')]={lockQuote:async(tx,scope,id)=>{const q=await tx.commercialDocument.findFirst({where:{id,branch_id:scope.branchId,branch:{company_id:scope.companyId}}});if(!q)throw Object.assign(Error('No encontrada'),{status:404});return q}}
 h.mocks[require.resolve('../src/modules/platform/registry')]={resolveEffectiveModules:()=>['quotes','sales'].map(code=>({code,effectiveEnabled:true}))}
 return h
}
async function run(fn){const h=harness();await withMocks(h.mocks,target,api=>fn(api,h))}
test('accepted quote creates one draft with accepted prices, net discounts and no stock or money effects',()=>run(async(api,h)=>{
 const a=await api.createQuoteSaleDraft(h.db,h.scope,h.quote.id),b=await api.createQuoteSaleDraft(h.db,h.scope,h.quote.id)
 assert.equal(a.id,b.id);assert.equal(a.status,'DRAFT');assert.equal(a.total,'20.50');assert.equal(a.originQuote.id,h.quote.id)
 assert.deepEqual(a.items.map(l=>l.lineTotal),['10.25','10.25']);assert.equal(a.items[0].unitPrice,'10.25');assert.equal(a.items[0].name,'Precio aceptado')
 assert.equal(h.state.sales.length,1);assert.equal(h.quote.documentSales.length,1);assert.deepEqual(h.state.effects,[]);assert.equal(h.state.sales[0].payment_method_id,null)
}))
test('quote conversion rejects unaccepted, order, Agenda, wrong scope and missing permissions',()=>run(async(api,h)=>{
 h.quote.status='SENT';await assert.rejects(api.createQuoteSaleDraft(h.db,h.scope,h.quote.id),{code:'QUOTE_NOT_ACCEPTED'});h.quote.status='ACCEPTED'
 h.quote.convertedChildren=[{id:randomUUID()}];await assert.rejects(api.createQuoteSaleDraft(h.db,h.scope,h.quote.id),{code:'QUOTE_ALREADY_LINKED'});h.quote.convertedChildren=[]
 h.quote.quoted_engagement={id:randomUUID()};await assert.rejects(api.createQuoteSaleDraft(h.db,h.scope,h.quote.id),{code:'QUOTE_ALREADY_LINKED'});h.quote.quoted_engagement=null
 await assert.rejects(api.createQuoteSaleDraft(h.db,{...h.scope,permissions:['sales.create']},h.quote.id),{status:403})
 await assert.rejects(api.createQuoteSaleDraft(h.db,{...h.scope,branchId:randomUUID()},h.quote.id),{status:404});assert.equal(h.state.sales.length,0)
}))
test('quote draft cannot be repriced or reassigned through manual save',()=>run(async(api,h)=>{
 const draft=await api.createQuoteSaleDraft(h.db,h.scope,h.quote.id)
 await withMocks(h.mocks,require.resolve('../src/modules/sales/manualSales'),async manual=>assert.rejects(manual.saveManualSale(h.db,h.scope,draft.id,{...h.input(),expectedVersion:1}),{code:'SOURCE_OWNS_AGREEMENT'}))
 assert.equal(h.state.sales[0].total,'20.50')
}))
test('free-text or inactive quote customer is rejected before creating an unconfirmable draft',()=>run(async(api,h)=>{
 h.quote.customer_contact_id=null;await assert.rejects(api.createQuoteSaleDraft(h.db,h.scope,h.quote.id),{code:'CONTACT_REQUIRED'})
 h.quote.customer_contact_id=h.customer.id;h.customer.deleted=true;await assert.rejects(api.createQuoteSaleDraft(h.db,h.scope,h.quote.id),{code:'CONTACT_REQUIRED'})
 assert.equal(h.state.sales.length,0);assert.equal(h.quote.documentSales.length,0)
}))
test('confirming quote draft excludes and consumes its own reservation exactly once',()=>run(async(api,h)=>{
 const draft=await api.createQuoteSaleDraft(h.db,h.scope,h.quote.id),input={expectedVersion:1,idempotencyKey:randomUUID(),dueDate:'2099-01-01'}
 const mocks={...h.mocks,[require.resolve('../src/services/stockAvailability')]:{assertLinesAvailable:async(tx,items,options)=>{assert.equal(options.excludeDocumentId,h.quote.id);h.state.effects.push('availability')},consumeByDocument:async(tx,id)=>{assert.equal(id,h.quote.id);h.state.effects.push('consume')}}}
 await withMocks(mocks,require.resolve('../src/modules/sales/manualSales'),async manual=>{
  const confirmed=await manual.confirmManualSale(h.db,h.scope,draft.id,input);assert.equal(confirmed.total,'20.50');assert.equal(confirmed.id,draft.id)
  await manual.confirmManualSale(h.db,h.scope,draft.id,input);assert.deepEqual(h.state.effects,['availability','stock','consume','accounting'])
 })
}))
test('cancelling quote draft releases the original soft reservation without restoring stock',()=>run(async(api,h)=>{
 const draft=await api.createQuoteSaleDraft(h.db,h.scope,h.quote.id)
 const mocks={...h.mocks,[require.resolve('../src/services/stockAvailability')]:{releaseByDocument:async(tx,id)=>{assert.equal(id,h.quote.id);h.state.effects.push('release')}}}
 await withMocks(mocks,require.resolve('../src/modules/sales/manualSales'),async manual=>{
  const cancelled=await manual.cancelManualSale(h.db,h.scope,draft.id,{expectedVersion:1,idempotencyKey:randomUUID()});assert.equal(cancelled.status,'CANCELLED')
 })
 assert.deepEqual(h.state.effects,['release']);assert.equal(h.quote.documentSales.length,1)
}))
test('simultaneous conversion is one draft and an unrelated creator cannot obtain its linked sale',()=>run(async(api,h)=>{
 const [a,b]=await Promise.all([api.createQuoteSaleDraft(h.db,h.scope,h.quote.id),api.createQuoteSaleDraft(h.db,h.scope,h.quote.id)]);assert.equal(a.id,b.id);assert.equal(h.state.sales.length,1)
 await assert.rejects(api.createQuoteSaleDraft(h.db,{...h.scope,userId:randomUUID(),permissions:['quotes.manage','sales.create']},h.quote.id),{status:404});assert.equal(h.state.sales.length,1)
}))
test('accepted presentation and exact base quantity survive catalogue changes in a v2 quote',()=>run(async(api,h)=>{
 const unitId=randomUUID(),snapshot={version:2,baseUnit:{id:unitId,code:'H',name:'Hora',label:'h',decimals:2},presentation:{id:randomUUID(),version:1,name:'Paquete',label:'paquete',decimals:2},factor:'12',roundingDelta:'0'}
 Object.assign(h.product,{unit_metadata_version:2,base_unit_id:unitId,unit_revision:9,quantity_decimals:2,price:'999'})
 h.quote.lines=h.quote.lines.map(l=>({...l,unit_metadata_version:2,unit_snapshot:snapshot,base_qty:'15'}))
 const draft=await api.createQuoteSaleDraft(h.db,h.scope,h.quote.id)
 assert.equal(h.state.sales[0].unit_metadata_version,2);assert.equal(draft.items[0].baseQty,'15');assert.equal(draft.items[0].unitPrice,'10.25');assert.equal(draft.items[0].lineTotal,'10.25');assert.deepEqual(draft.items[0].unitSnapshot,snapshot)
}))
