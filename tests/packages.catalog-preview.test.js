const test=require('node:test'),assert=require('node:assert/strict')
const {fixture}=require('./helpers/packagesDb'),{id}=require('./helpers/packageFixtures')
const catalog=require('../src/modules/inventory/packages/catalog')
test('package catalog returns image and exact price range without internal composition or cost data',async()=>{
 const f=fixture(),input=f.input();input.definition.imageUrl='https://example.com/package.webp'
 input.definition.variants.push({id:id(90),name:'Grande',price:'2499.00',components:[],choices:[]})
 const saved=await catalog.savePackage(f.db,f.scope,null,input)
 const page=await catalog.listPackages(f.db,f.scope,{includeSummary:true})
 assert.equal(page.totalItems,1);assert.equal(page.items[0].imageUrl,input.definition.imageUrl)
 assert.equal(page.items[0].priceFrom,'1599.00');assert.equal(page.items[0].priceTo,'2499.00');assert.equal(page.items[0].variantCount,2)
 assert.ok(!('definition'in page.items[0]));assert.ok(!('components'in page.items[0]))
 f.state.products[0].cost='PRIVATE'
 const detail=await catalog.getPackage(f.db,f.scope,saved.id)
 assert.equal(detail.references.find(p=>p.id===id(20)).name,'Artículo 20')
 assert.doesNotMatch(JSON.stringify(detail.references),/PRIVATE|cost|company_id/)
 await assert.rejects(catalog.getPackage(f.db,{...f.scope,companyId:id(999)},saved.id),{status:404})
})
