const test=require('node:test'),assert=require('node:assert/strict')
const {agreementFixture}=require('./helpers/packageAgreementFixture')
const {id}=require('./helpers/packageFixtures')
test('operational package catalog uses only published definitions and never exposes a private draft',async()=>{
 const f=await agreementFixture(),record=f.state.versions[0],calls=[]
 f.db.$queryRaw=async(strings,...values)=>{calls.push(values);return[{id:f.packageId,active_version:1,definition:record.definition,draft_definition:{secret:'PRIVATE'}}]}
 const scope={...f.scope,userId:f.scope.actorId,permissions:['sales.create']}
 const out=await require('../src/modules/sales/packageSales').listSalePackages(f.db,scope,{q:'evento',activeOnly:'true'})
 assert.equal(out.items[0].name,'Paquete de evento');assert.equal(out.items[0].priceFrom,'1599.00')
 assert.doesNotMatch(JSON.stringify(out),/PRIVATE|draft_definition/)
 assert.ok(calls[0].includes(scope.companyId));assert.ok(calls[0].includes(scope.branchId))
 await assert.rejects(require('../src/modules/sales/packageSales').listSalePackages(f.db,{...scope,permissions:['products.view']},{}),{status:403})
})
test('sales-only operators resolve complete published packages into real priced sale lines',async()=>{
 const f=await agreementFixture(),scope={...f.scope,userId:f.scope.actorId,permissions:['sales.create']}
 const result=await require('../src/modules/sales/packageSales').resolveSalePackages(f.db,scope,[f.selection()])
 assert.equal(result.subtotal,'1599.00');assert.equal(result.groups.length,1);assert.equal(result.lines.length,3)
 assert.deepEqual(result.lines.map(l=>l.line_total),['319.80','639.60','639.60'])
 assert.ok(result.lines.every(l=>l.package_component_key&&l.unit_cost!==undefined))
 await assert.rejects(require('../src/modules/sales/packageSales').resolveSalePackages(f.db,{...scope,permissions:[]},[f.selection()]),{status:403})
 await assert.rejects(require('../src/modules/sales/packageSales').resolveSalePackages(f.db,scope,[f.selection([{optionId:id(4),quantity:'1'}])]),{code:'PACKAGE_SELECTION_INCOMPLETE'})
 const draft=await require('../src/modules/sales/packageSales').resolveSalePackages(f.db,scope,[f.selection([{optionId:id(4),quantity:'1'}])],{allowIncomplete:true})
 assert.equal(draft.groups[0].state,'INCOMPLETE');assert.deepEqual(draft.lines,[])
})
test('published package prices stay intact when promotions discount only independent items',async()=>{
 const f=await agreementFixture(),p=require('../src/modules/sales/packageSales'),out=await p.resolveSalePackages(f.db,{...f.scope,userId:f.scope.actorId,permissions:['sales.create']},[f.selection()])
 const items=[{product_id:id(23),qty:'1',price:'10.00'},...out.lines.map(l=>({...l,price:l.unit_price}))]
 const lines=p.salePackageNetLines(items,'1604.00')
 assert.equal(lines[0],'5.00');assert.deepEqual(lines.slice(1),['319.80','639.60','639.60'])
 assert.throws(()=>p.salePackageNetLines(items,'1598.99'),{code:'PACKAGE_PRICE_PROTECTED'})
})
test('checkout replay includes package selections instead of treating another package as the same sale',()=>{
 const {checkoutHash}=require('../src/modules/sales/checkoutAttempts')
 const first={items:[],packages:[{groupId:'g',packageId:'p',variantId:'a',version:1,choices:[]}]}
 assert.notEqual(checkoutHash('SALE',first),checkoutHash('SALE',{...first,packages:[{...first.packages[0],variantId:'b'}]}))
})
