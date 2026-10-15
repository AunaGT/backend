const test=require('node:test'),assert=require('node:assert/strict')
const {devDbEnabled,withSalesDevFixture}=require('./helpers/salesDevFixture.cjs')
test('sales revenue summary excludes null-method draft while pipeline remains visible',{skip:!devDbEnabled},()=>withSalesDevFixture(async({db,scope,fixtures:f})=>{
  const status=await db.saleStatus.findUnique({where:{name:'Borrador'}})
  await db.sale.create({data:{branch_id:scope.branchId,customer_contact_id:f.contactId,total:999999,adjusted_total:999999,items:0,status_id:status.id,payment_method_id:null,payment_status:'PENDING'}})
  const req={companyId:scope.companyId,branchId:scope.branchId,user:{sub:scope.userId,role_name:'admin'},query:{includeSummary:'true',pageSize:'10'}}
  const result=await new Promise((resolve,reject)=>require('../src/modules/sales/controller').list(req,{json:resolve,status(){return this}},reject))
  assert.equal(result.summary.totalSales,90)
  assert.equal(result.summary.transactionCount,1)
  assert.equal(result.summary.draftCount,1)
  assert.equal(result.summary.draftTotal,999999)
  assert.equal(result.items.length,2)
  assert.equal((await require('../src/modules/receivables/domain/receivables').openSalesOf(db,f.contactId,{branch_id:scope.branchId})).length,1)
}))
