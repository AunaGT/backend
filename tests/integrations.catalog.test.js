const test=require('node:test'),assert=require('node:assert/strict'),{COMPANY,BRANCH}=require('./helpers/integrationsDb')
const id='44444444-4444-4444-8444-444444444444',foreign='55555555-5555-4555-8555-555555555555'
const context={companyId:COMPANY,scopes:['products.read','categories.read','prices.read','availability.read'],branches:[{id:BRANCH,name:'Principal'}],servicesEnabled:true,unitsEnabled:true,currency:'GTQ'}
const product={id,company_id:COMPANY,name:'Harina',kind:'STANDARD',deleted:false,available_for_sale:true,quantity_decimals:3,base_unit:{id:'u',label:'kg'},category:{id:1,name:'Granos'},presentations:[],barcodes:[{code:'00123',presentation_id:null}],price:'12.123456',price_promotion:'10.000001',promotion_valid_until:new Date('2026-01-01'),cost:'999',supplier:{name:'PRIVATE'},secret:'PRIVATE'}
test('catalog projections never leak pricing, costs, stock or new internal fields',async()=>{
 const {listProducts,getProduct}=require('../src/modules/integrations/catalog'),calls=[]
 const db={product:{findMany:async q=>{calls.push(q);return[product]},findFirst:async q=>{calls.push(q);return product}}}
 const result=await listProducts(db,context,{limit:'25'})
 assert.equal(result.items[0].barcodes[0].code,'00123');assert.doesNotMatch(JSON.stringify(result),/PRIVATE|cost|price|stock|supplier|secret/)
 assert.equal(calls[0].where.company_id,COMPANY);assert.equal(calls[0].take,26)
 await getProduct(db,context,id);assert.equal(calls[1].where.company_id,COMPANY)
 await assert.rejects(()=>listProducts(db,context,{include:'supplier'}),{status:400})
 await assert.rejects(()=>listProducts(db,context,{limit:'101'}),{status:400})
 await assert.rejects(()=>listProducts(db,context,{cursor:'evil'}),{status:400})
})
test('mixed tenant batches and unknown branches are rejected without returning partial prices',async()=>{
 const {getPrices}=require('../src/modules/integrations/catalog'),db={product:{findMany:async()=>[product]}}
 await assert.rejects(()=>getPrices(db,context,{productIds:id+','+foreign,branchId:BRANCH}),{status:404})
 await assert.rejects(()=>getPrices(db,context,{productIds:id,branchId:foreign}),{status:403})
 await assert.rejects(()=>getPrices(db,context,{productIds:id}),{status:400})
 await assert.rejects(()=>getPrices(db,{...context,scopes:['products.read']},{productIds:id,branchId:BRANCH}),{status:403})
})
test('public prices preserve six decimals, presentation conversion and expired promotions',async()=>{
 const {getPrices}=require('../src/modules/integrations/catalog'),db={product:{findMany:async()=>[{...product,presentations:[{id:'pack',label:'bolsa',factor:'0.125',quantity_decimals:0,price:null,price_promotion:null}]}]}}
 const result=await getPrices(db,context,{productIds:id,branchId:BRANCH},new Date('2026-10-25'))
 assert.equal(result.items[0].amount,'12.123456');assert.equal(result.items[0].presentations[0].amount,'1.515432')
 assert.equal(result.items[0].promotion,null);assert.doesNotMatch(JSON.stringify(result),/cost|WHOLESALE|supplier/)
})
test('services explicitly have no physical availability and do not create inventory rows',async()=>{
 const {getAvailability}=require('../src/modules/integrations/catalog'),db={product:{findMany:async()=>[{...product,kind:'SERVICE',service_unit_label:'hora',base_unit:null}]}}
 const result=await getAvailability(db,context,{productIds:id,branchId:BRANCH},new Date('2026-10-25'))
 assert.equal(result.items[0].status,'NOT_APPLICABLE');assert.equal(result.items[0].quantity,null);assert.equal(result.items[0].unit.label,'hora')
})
test('sellable barcode references exclude purchase-only, inactive or truncated-out presentations',async()=>{
 const {getProduct}=require('../src/modules/integrations/catalog'),db={product:{findFirst:async()=>({...product,presentations:[{id:'sale',name:'Caja',label:'Caja',factor:'12',quantity_decimals:0}],barcodes:[{code:'UNIT',presentation_id:null},{code:'CASE-12',presentation_id:'sale'},{code:'PURCHASE',presentation_id:'purchase'},{code:'INACTIVE',presentation_id:'old'}]})}}
 const out=await getProduct(db,context,id);assert.deepEqual(out.barcodes,[{code:'UNIT',presentationId:null},{code:'CASE-12',presentationId:'sale'}])
 const basic=await getProduct(db,{...context,unitsEnabled:false},id);assert.deepEqual(basic.barcodes,[{code:'UNIT',presentationId:null}])
})
test('legacy base barcodes remain available without writes or duplicate registry entries',async()=>{
 const {getProduct}=require('../src/modules/integrations/catalog');let registered=[];const db={product:{findFirst:async({select})=>{assert.equal(select.barcode,true);return{...product,barcode:'0012345',barcodes:registered}}}}
 assert.deepEqual((await getProduct(db,context,id)).barcodes,[{code:'0012345',presentationId:null}])
 registered=[{code:'0012345',presentation_id:null}];assert.equal((await getProduct(db,context,id)).barcodes.length,1)
})
