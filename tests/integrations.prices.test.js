const test=require('node:test'),assert=require('node:assert/strict'),{COMPANY,BRANCH}=require('./helpers/integrationsDb')
const id='44444444-4444-4444-8444-444444444444',context={companyId:COMPANY,scopes:['prices.read'],branches:[{id:BRANCH}],unitsEnabled:true,servicesEnabled:true,currency:'GTQ'}
test('prices expose only public list and current promotions using exact unit conversion',async()=>{
 const {getPrices}=require('../src/modules/integrations/catalog'),now=new Date('2026-10-25T12:00:00Z'),p={id,company_id:COMPANY,price:'12.123456',price_promotion:'10.123456',promotion_valid_until:new Date('2026-10-26T12:00:00Z'),quantity_decimals:3,base_unit:{id:'kg',label:'kg'},presentations:[{id:'bag',label:'Bolsa',factor:'0.125',price:'1.8',price_promotion:'1.5',promotion_valid_until:new Date('2026-10-26T12:00:00Z')}],price_wholesale:'0.01',cost:'SECRET'}
 let calls=0;const db={product:{findMany:async()=>{calls++;return[p]}}},out=await getPrices(db,context,{productIds:id,branchId:BRANCH},now)
 assert.equal(calls,1);assert.equal(out.items[0].amount,'12.123456');assert.equal(out.items[0].promotion.amount,'10.123456');assert.equal(out.items[0].presentations[0].amount,'1.8');assert.equal(out.items[0].presentations[0].promotion.amount,'1.5');assert.equal(out.asOf,now.toISOString());assert.doesNotMatch(JSON.stringify(out),/SECRET|wholesale|WHOLESALE|cost/)
 await assert.rejects(()=>getPrices(db,context,{productIds:Array(101).fill(id).join(','),branchId:BRANCH}),{status:400})
})
