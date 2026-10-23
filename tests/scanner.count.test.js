const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto')
test('count scanner only locates session lines, never adds a quantity or reads the whole catalogue',async()=>{
 const {findCountScan}=require('../src/modules/inventory-count/scanner'),companyId=randomUUID(),branchId=randomUUID(),id=randomUUID(),productId=randomUUID();let writes=0,query
 const db={inventoryCountSession:{findFirst:async({where})=>{assert.equal(where.branch_id,branchId);assert.equal(where.branch.company_id,companyId);return{id,status:'IN_PROGRESS'}}},productBarcode:{findFirst:async()=>({product_id:productId})},inventoryCountLine:{findMany:async args=>{query=args;return[{id:'L1',product:{name:'Agua'},location:{code:'A',warehouse:{name:'Principal'}}},{id:'L2',product:{name:'Agua'},location:{code:'B',warehouse:{name:'Principal'}}}]},update:()=>writes++}}
 const rows=await findCountScan(db,{companyId,branchId},id,'001');assert.equal(rows.length,2);assert.equal(rows[0].lineId,'L1');assert.equal(query.where.session_id,id);assert.deepEqual(query.where.OR,[{product:{barcode:'001'}},{product_id:productId}]);assert.equal(writes,0)
 db.inventoryCountSession.findFirst=async()=>({id,status:'APPROVED'});await assert.rejects(findCountScan(db,{companyId,branchId},id,'001'),{status:409})
})
