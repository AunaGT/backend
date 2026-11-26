const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto')
const {withMocks,jsonResponse}=require('./helpers/reportHarness.cjs')
test('my turns is scoped to the authenticated actor and rejects API credentials; joining cannot spoof identity',async()=>{
 const companyId=randomUUID(),branchId=randomUUID(),sub=randomUUID(),calls=[]
 const req={companyId,branchId,user:{sub,permissions:['sales.create'],role:{name:'Cashier'}},query:{},body:{},params:{id:randomUUID()}}
 const prisma={$transaction:fn=>fn(prisma)}
 const call=async(api,action,request)=>{const res=jsonResponse();res.set=()=>res;let error;await api[action](request,res,e=>error=e);return{res,error}}
 await withMocks({[require.resolve('../src/models/prisma')]:{prisma},[require.resolve('../src/modules/cash-closure/myTurns')]:{myTurns:async(_,scope)=>{calls.push(scope);return{current:[],pending:[]}}}},require.resolve('../src/modules/cash-closure/myTurns.controller'),async api=>{
  assert.equal((await call(api,'view',{...req,integrationCredential:{id:'api'}})).error.status,401)
  assert.equal((await call(api,'view',{...req,user:{...req.user,permissions:[]}})).error.status,403)
  assert.equal((await call(api,'view',req)).res.statusCode,200)
  assert.equal(calls[0].userId,sub);assert.equal(calls[0].companyId,companyId);assert.equal(calls[0].branchId,branchId)
 })
 await withMocks({[require.resolve('../src/models/prisma')]:{prisma}},require.resolve('../src/modules/sales/cashSessions.controller'),async api=>{
  assert.equal((await call(api,'joinSession',{...req,body:{userId:randomUUID()}})).error.status,400)
  assert.equal((await call(api,'joinSession',{...req,integration:{id:'api'}})).error.status,401)
 })
})
