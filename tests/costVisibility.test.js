const test=require('node:test'),assert=require('node:assert/strict'),{Prisma}=require('@prisma/client')
let policy={};try{policy=require('../src/middlewares/costVisibility')}catch(e){if(e.code!=='MODULE_NOT_FOUND')throw e}
test('cost projection removes nested costs and derived values without hiding sale prices or quantities',()=>{
 assert.equal(typeof policy.projectCosts,'function')
 const input={price:'12.50',stock:'3',cost:'7',items:[{qty:'2',unit_cost:'4',baseUnitCost:'4',price:'8',physical_snapshot:{lots:[{unit_cost:'4'}]},unit_snapshot:{assembly:{value:'8',unit_cost:'4',qty:'2'}}}],totals:{valueDeltaApprox:'14',valueDifference:'7',inventoryValue:'21',count:3},marginPct:44,assembly_group_id:'A',value:'8'}
 const result=policy.projectCosts(input)
 assert.deepEqual(result,{price:'12.50',stock:'3',items:[{qty:'2',price:'8',physical_snapshot:{lots:[{}]},unit_snapshot:{assembly:{qty:'2'}}}],totals:{count:3},assembly_group_id:'A'})
 assert.equal(input.cost,'7');assert.equal(input.items[0].unit_cost,'4')
})
test('projection preserves dates, exact decimal serialization and non-cost value fields',()=>{
 assert.equal(typeof policy.projectCosts,'function')
 const price=new Prisma.Decimal('0.123456789012'),date=new Date('2026-01-01T12:00:00Z')
 const result=policy.projectCosts({price,date,option:{value:'blue'},items:null})
 assert.equal(result.price,price);assert.equal(result.date,date)
 assert.deepEqual(JSON.parse(JSON.stringify(result)),{price:'0.123456789012',date:'2026-01-01T12:00:00.000Z',option:{value:'blue'},items:null})
})
test('response boundary evaluates effective permissions after authentication and prevents caching',()=>{
 assert.equal(typeof policy.protectCostResponses,'function')
 for(const [user,visible] of [[{permissions:['products.create','products.edit']},false],[{permissions:['products.view_costs']},true],[{role:{name:'admin',system_key:'ADMIN',company_id:null}},true],[{role:{name:'Admin'}},false]]){
  const req={},headers={},res={setHeader:(key,value)=>headers[key]=value,json:body=>body}
  let next=false;policy.protectCostResponses(req,res,()=>next=true);req.user=user
  const body=res.json({id:'P',price:10,cost:3});assert.equal(next,true);assert.equal('cost'in body,visible)
  assert.equal(headers['Cache-Control'],'private, no-store')
 }
})
