const test=require('node:test'),assert=require('node:assert/strict')
const {COMPANY,OWNER}=require('./helpers/integrationsDb')
const context={companyId:COMPANY,unitsEnabled:true,servicesEnabled:true}
const product={id:OWNER,company_id:COMPANY,name:'Café',kind:'STANDARD',available_for_sale:true,deleted:false,price:'12.123456',unit_metadata_version:2,unit_revision:1,base_unit_id:OWNER,quantity_decimals:6,default_sale_presentation_id:OWNER}
const base={id:OWNER,code:'KG',name:'Kilogramo',label:'kg'},presentation={id:OWNER,product_id:OWNER,company_id:COMPANY,name:'Bolsa',label:'bolsa',active:true,sale_enabled:true,quantity_decimals:0,version:1,factor:'0.125'}
function db(p=product,pres=presentation){return new Proxy({$executeRaw:async()=>0,product:{findFirst:async({where})=>p.company_id===where.company_id&&p.id===where.id&&!p.deleted&&p.available_for_sale?p:null},measureUnit:{findFirst:async()=>base},productPresentation:{findFirst:async()=>pres}},{get:(o,k)=>{if(k in o)return o[k];throw Error(`forbidden side effect: ${String(k)}`)}})}
const build=(database,items=[{productId:OWNER,quantity:'2',unitRevision:1}])=>require('../src/modules/integrations/draftLines').buildDraftLines(database,context,'QUOTE',items,new Date('2026-10-25T12:00:00Z'))
test('draft uses exact public factor prices without stock reads or writes',async()=>{
 const out=await build(db());assert.equal(out.total,'3.03');assert.equal(out.lines[0].unit_price,'1.515432');assert.equal(out.lines[0].base_qty,'0.25')
})
test('current promotion applies, expired does not, explicit presentation zero is preserved',async()=>{
 for(const [pres,want] of [[{...presentation,price_promotion:'0',promotion_valid_until:new Date('2027-01-01')},'0.00'],[{...presentation,price_promotion:'2',promotion_valid_until:new Date('2027-01-01')},'4.00'],[{...presentation,price_promotion:'2',promotion_valid_until:new Date('2025-01-01')},'3.03']])assert.equal((await build(db(product,pres))).total,want)
})
test('foreign, unavailable, stale revision and inexact conversion do not become drafts',async()=>{
 await assert.rejects(()=>build(db({...product,company_id:'foreign'})),{status:404})
 await assert.rejects(()=>build(db({...product,available_for_sale:false})),{status:404})
 await assert.rejects(()=>build(db(),[{productId:OWNER,quantity:'2',unitRevision:2}]),{status:409})
 await assert.rejects(()=>build(db({...product,quantity_decimals:0})),{status:409})
})
test('public catalog exposes the unit revision needed for drafts and respects zero presentation promotions',async()=>{
 const {getProduct,getPrices}=require('../src/modules/integrations/catalog')
 const p={...product,category:{id:1,name:'QA'},base_unit:{id:OWNER,label:'kg'},barcodes:[],presentations:[{...presentation,price_promotion:'0',promotion_valid_until:new Date('2027-01-01')}]}
 const ctx={...context,currency:'GTQ',scopes:['products.read','prices.read'],branches:[{id:OWNER}]},database={product:{findFirst:async()=>p,findMany:async()=>[p]}}
 assert.equal((await getProduct(database,ctx,OWNER)).unitRevision,1)
 assert.equal((await getPrices(database,ctx,{productIds:OWNER,branchId:OWNER},new Date('2026-10-25'))).items[0].presentations[0].promotion.amount,'0')
})
