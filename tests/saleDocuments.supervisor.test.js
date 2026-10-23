const test=require('node:test'),assert=require('node:assert/strict')
const {supervisedRender}=require('../src/modules/sales/documents/worker')
const {resolveBase,freezeProfile}=require('../src/modules/config/documentTemplates/public')
const {sampleData}=require('./fixtures/documentTemplates/data')
test('the actual isolated Node process renders a bounded PDF and reports its observed memory',async()=>{
  const result=await supervisedRender({data:sampleData(20),profile:freezeProfile(resolveBase('CLASSIC','A4')),assets:{},limits:{preview:true}})
  assert.equal(result.buffer.subarray(0,5).toString(),'%PDF-');assert.ok(result.observedRss>0);assert.ok(result.pageCount>=1&&result.pageCount<=20)
})
