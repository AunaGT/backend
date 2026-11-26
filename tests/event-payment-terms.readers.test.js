const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path')
const {withMocks,jsonResponse}=require('./helpers/reportHarness.cjs')
const {id}=require('./helpers/packageFixtures')
const terms={schemaVersion:1,depositPercent:'25.00',basisTotal:'100.00',balanceDaysBefore:1,referenceStartsAt:'2026-03-09T06:30:00Z',referenceTimezone:'America/New_York',currencyCode:'GTQ'}
for(const kind of ['orders','sales'])test(`${kind} saved detail projects the server deadline without collection history`,async()=>{
 const row={id:id(1),event_payment_terms:terms,branch_id:id(2),status:{name:'Completada'},sale_items:[],total:'100.00'}
 const db={sale:{findFirst:async()=>row},commercialDocument:{findFirst:async()=>row}}
 const mocks={
  [require.resolve('../src/models/prisma')]:{prisma:db,prismaTransaction:db},
  [require.resolve('../src/modules/appointments')]:{linkedEngagementOrigins:async()=>({orderEngagementId:null})},
  [require.resolve('../src/modules/sales/fiscalRequests')]:{fiscalEnabled:async()=>false},
 }
 await withMocks(mocks,path.resolve(__dirname,`../src/modules/${kind}/controller`),async controller=>{
  const res=jsonResponse();let error
  await controller.getById({params:{id:row.id},companyId:id(3),branchId:row.branch_id,user:{sub:id(4),permissions:['sales.view_detail']}},res,e=>{error=e})
  assert.equal(error,undefined);assert.equal(res.body.eventPaymentTerms.dueAt,'2026-03-08T07:30:00.000Z');assert.equal(res.body.eventPaymentTerms.depositRequired,'25.00')
  assert.equal(res.body.eventPaymentTerms.paid,undefined)
 })
})
