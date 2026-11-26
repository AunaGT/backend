const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto')
const {withMocks,jsonResponse}=require('./helpers/reportHarness.cjs')
const companyId=randomUUID(),branchId=randomUUID(),userId=randomUUID(),id=randomUUID()
const request=(permissions,body={})=>({companyId,branchId,user:{sub:userId,role:{name:'Cajero'},permissions},body,query:{},params:{movementId:id}})
async function call(api,action,req){const res=jsonResponse();res.set=()=>res;let error;await api[action](req,res,e=>error=e);return {res,error}}
test('physical HTTP adapters keep their own scoped permission gate and return real idempotent receipts',async()=>{
  const service=require.resolve('../src/modules/cash-closure/physicalMovements'),controller=require.resolve('../src/modules/cash-closure/physicalMovements.controller'),prisma=require.resolve('../src/models/prisma')
  let saved=0;const db={$transaction:fn=>fn(db)}
  await withMocks({[prisma]:{prisma:db},[service]:{createPhysicalMovement:async(_,scope,input)=>{assert.equal(scope.branchId,branchId);saved++;return {id,replayed:input.replay===true}}}},controller,async api=>{
    for(const permissions of [[],['sales.create'],['cash.registers.manage'],['cashclosure.create'],['cash.movements.view_team']])assert.equal((await call(api,'create',request(permissions))).error.status,403)
    const fresh=await call(api,'create',request(['cash.movements.create_own']));assert.equal(fresh.res.statusCode,201);assert.equal(fresh.res.body.id,id)
    assert.equal((await call(api,'create',request(['cash.movements.create_team'],{replay:true}))).res.statusCode,200);assert.equal(saved,2)
  })
})
test('missing physical schema exposes no false action and does not load operational tables',async()=>{
  const service=require.resolve('../src/modules/cash-closure/physicalMovements'),controller=require.resolve('../src/modules/cash-closure/physicalMovements.controller'),prisma=require.resolve('../src/models/prisma')
  await withMocks({[prisma]:{prisma:{}},[service]:{physicalMovementsAvailable:async()=>false}},controller,async api=>{
    const {res,error}=await call(api,'capabilities',request(['cash.movements.create_own']))
    assert.equal(error,undefined);assert.equal(res.body.available,false)
  })
})
