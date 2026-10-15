const test=require('node:test'),assert=require('node:assert/strict')
const {withMocks,jsonResponse}=require('./helpers/reportHarness.cjs')
test('history ID filter keeps tenant/branch scope and legacy names remain compatible',async()=>{
  let where,reads=0
  const db={sale:{count:async args=>{where=args.where;reads++;return 0},findMany:async()=>[]},systemSetting:{findMany:async()=>[]}}
  await withMocks({[require.resolve('../src/models/prisma')]:{prisma:db,prismaTransaction:db}},require.resolve('../src/modules/sales/controller'),async ctrl=>{
    const req={companyId:'A',branchId:'B',user:{permissions:['sales.view']},query:{payment_method_id:'12',pageSize:10}}
    await ctrl.list(req,jsonResponse(),e=>{throw e})
    assert.equal(where.payment_method_id,12);assert.equal(where.branch_id,'B');assert.equal(where.payment_method,undefined)
    req.query={payment:'Efectivo'};await ctrl.list(req,jsonResponse(),e=>{throw e})
    assert.deepEqual(where.payment_method,{name:{equals:'Efectivo',mode:'insensitive'}})
    for(const id of ['-1','0','12x','2147483648',true,['12']]){
      const prior=reads,res=jsonResponse();req.query={payment_method_id:id}
      await ctrl.list(req,res,e=>{throw e});assert.equal(res.statusCode,400);assert.equal(reads,prior)
    }
  })
})
