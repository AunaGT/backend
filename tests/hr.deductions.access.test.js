const test = require('node:test'), assert = require('node:assert/strict')
const { withMocks, jsonResponse } = require('./helpers/reportHarness.cjs')
const EMP = '11111111-1111-4111-8111-111111111111'
test('a transferred employees deduction is absent from former branch results and totals', async () => {
  const db = { employeeDeduction: { count: async ({where}) => where.employee?.branch_id === 'A' ? 0 : 1, findMany: async ({where}) => where.employee?.branch_id === 'A' ? [] : [{ employee_id: EMP, reason: 'Private', amount: '20' }] } }
  await withMocks({ [require.resolve('../src/models/prisma')]: { prisma: db, prismaTransaction: db } }, require.resolve('../src/modules/hr/controllers/deductions'), async controller => {
    for (const query of [{}, {employee_id:EMP}]) {
      const res = { ...jsonResponse(), set() {return this} }
      await controller.list({companyId:'C',branchId:'A',user:{permissions:['hr.deductions.view']},query},res,e=>{throw e})
      assert.equal(res.body.totalItems,0);assert.deepEqual(res.body.items,[])
    }
  })
})
test('permission revocation while a mutation waits for employee lock prevents all writes', async () => {
  let release, waiting, writes=0
  const held=new Promise(r=>release=r),started=new Promise(r=>waiting=r)
  const tx = { $queryRaw:async()=>{waiting();await held;return[{id:EMP}]}, employee:{findFirst:async()=>({id:EMP})}, employeeDeduction:{create:async()=>{writes++;return{id:'D',employee_id:EMP}}},employeeHistory:{create:async()=>{}},user:{findUnique:async()=>({id:EMP,auth_version:0,role:{name:'cashier',permissions:[]},user_companies:[{company_id:'C',status:'ACTIVE',role:{name:'cashier',permissions:[]}}]})},userBranch:{findUnique:async()=>({branch:{company_id:'C',active:true,company:{active:true}}})} }
  tx.$transaction=fn=>fn(tx)
  await withMocks({[require.resolve('../src/models/prisma')]:{prisma:tx,prismaTransaction:tx}},require.resolve('../src/modules/hr/controllers/deductions'),async controller=>{
    const result=controller.create({companyId:'C',branchId:'B',params:{},user:{sub:EMP,auth_version:0,permissions:['hr.deductions.manage']},body:{employee_id:EMP,amount:'20.00',reason:'Motivo'}},jsonResponse(),e=>{throw e})
    await started;release()
    await assert.rejects(result,e=>e.status===403);assert.equal(writes,0)
  })
})
