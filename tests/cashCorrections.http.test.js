const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto')
const {withMocks}=require('./helpers/reportHarness.cjs')
test('HTTP correction boundaries reject integration/all/read-only writes before calling storage',async()=>{
  let calls=0
  await withMocks({[require.resolve('../src/models/prisma')]:{prisma:{}},[require.resolve('../src/modules/cash-closure/corrections')]:{proposeCorrection(){calls++},previewCorrection(){calls++}}},require.resolve('../src/modules/cash-closure/corrections.controller'),async http=>{
    const request=()=>({companyId:randomUUID(),branchId:randomUUID(),user:{sub:randomUUID(),permissions:['cashclosure.view'],role:{name:'admin'}},params:{id:randomUUID()},body:{}})
    for(const mutate of [r=>r,r=>({...r,integrationCredential:{}}),r=>({...r,branchId:'all',user:{...r.user,permissions:['cashclosure.correct']}})]){
      const res={set(){return this},json(){throw Error('should deny')}},req=mutate(request());let error
      await http.preview(req,res,e=>error=e);assert.ok([401,403].includes(error?.status))
    }
  })
  assert.equal(calls,0)
})
