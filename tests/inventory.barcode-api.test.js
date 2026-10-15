const {test}=require('node:test'),assert=require('node:assert/strict')
const {listBarcodeCandidates}=require('../src/modules/inventory/barcodeLabels/layouts')
test('candidate query applies eligibility and scope with safe selected columns',async()=>{
  let seen
  const scope={companyId:'11111111-1111-4111-8111-111111111111',branchId:'22222222-2222-4222-8222-222222222222',branchIds:['22222222-2222-4222-8222-222222222222'],isAdmin:false,permissions:['products.view']}
  const db={companyModule:{findMany:async()=>[{module_code:'inventory',status:'ACTIVE'}]},branch:{findFirst:async()=>({id:scope.branchId})},product:{count:async()=>1,findMany:async q=>{seen=q;return[{id:'product',name:'QA',barcode:'00001234',price:25,brand:null,size:null}]}}}
  const result=await listBarcodeCandidates(db,scope,{search:'QA',page:'1',pageSize:'10',in_branch:'true'})
  assert.equal(result.items[0].barcode,'00001234');assert.equal(seen.where.company_id,scope.companyId);assert.equal(seen.where.available_for_sale,true);assert.equal(seen.where.deleted,false)
  assert.deepEqual(seen.where.kind,{not:'SERVICE'});assert.deepEqual(seen.where.branch_stocks,{some:{branch_id:scope.branchId}});assert.equal(seen.select.cost,undefined)
  await assert.rejects(()=>listBarcodeCandidates(db,scope,{page:'0'}),e=>e.status===400)
  await assert.rejects(()=>listBarcodeCandidates(db,{...scope,permissions:[]},{}),e=>e.status===403)
})
