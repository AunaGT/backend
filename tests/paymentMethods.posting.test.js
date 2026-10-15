const test=require('node:test'),assert=require('node:assert/strict')
const {buildSalePosting,buildReturnPosting}=require('../src/services/accounting/postingEngine')
const {applyOpeningFloatToCashBreakdown,applyReturnSettlements}=require('../src/modules/cash-closure/domain')
test('closure rejects invalid unidentified collection metadata before any database work',async()=>{
  const {withMocks,jsonResponse}=require('./helpers/reportHarness.cjs')
  await withMocks({[require.resolve('../src/models/prisma')]:{prisma:{}},[require.resolve('../src/utils/getTimezone')]:{getTimezone:async()=>{throw new Error('Unexpected database work')}}},require.resolve('../src/modules/cash-closure/controller'),async ctrl=>{
    for(const amount of [Infinity,-1,'25',true,{},10000000000]){
      const res=jsonResponse()
      await ctrl.create({body:{startDate:'2026-10-15T00:00:00',endDate:'2026-10-15T23:59:59',cashierName:'QA',unidentifiedCollectionsAmount:amount},user:{role:{name:'admin'}}},res,e=>{throw e})
      assert.equal(res.statusCode,400)
      assert.match(res.body.message,/importe.*medio no registrado/i)
    }
  })
})
test('closure persists unidentified collection evidence but still requires a human difference reason',async()=>{
  const {withMocks,jsonResponse}=require('./helpers/reportHarness.cjs')
  const saved=[]
  const tx={cashClosure:{create:async({data})=>{saved.push(data);return{id:'C'}},findUnique:async()=>({id:'C'})}}
  await withMocks({[require.resolve('../src/models/prisma')]:{prisma:{$transaction:async work=>work(tx)}},[require.resolve('../src/utils/getTimezone')]:{getTimezone:async()=> 'America/Guatemala'}},require.resolve('../src/modules/cash-closure/controller'),async ctrl=>{
    const req={branchId:'B',companyId:'A',user:{sub:'U',role:{name:'admin'}},body:{startDate:'2026-10-15T00:00:00',endDate:'2026-10-15T23:59:59',cashierName:'QA',theoreticalTotal:25,actualTotal:0,unidentifiedCollectionsAmount:25,notes:''}}
    const missing=jsonResponse();await ctrl.create(req,missing,e=>{throw e})
    assert.equal(missing.statusCode,400);assert.equal(saved.length,0)
    const res=jsonResponse();await ctrl.create({...req,body:{...req.body,notes:'Recuento revisado por supervisor'}},res,e=>{throw e})
    assert.equal(res.statusCode,201)
    assert.match(saved[0].notes,/Recuento revisado por supervisor/)
    assert.match(saved[0].notes,/25\.00.*moneda del cierre/)
    assert.match(saved[0].notes,/no asignados a efectivo/)
  })
})
test('closure evidence keeps unidentified money explicit without supplying a difference justification',()=>{
  const {closureNotesWithUnidentifiedCollections,requiresDifferenceReason}=require('../src/modules/cash-closure/domain')
  assert.equal(requiresDifferenceReason(-25,''),true)
  const note=closureNotesWithUnidentifiedCollections('Recuento del supervisor',25)
  assert.match(note,/Recuento del supervisor/);assert.match(note,/25\.00/);assert.match(note,/medio no registrado/i)
  assert.equal(closureNotesWithUnidentifiedCollections('',0),null)
})
test('closure retains legacy unclassified receipt total without inventing a cash method',async()=>{
  const {withMocks,jsonResponse}=require('./helpers/reportHarness.cjs')
  const db={saleStatus:{findFirst:async()=>({id:1})},sale:{findMany:async()=>[]},
    customerPayment:{findMany:async()=>[{id:'R',amount:25,paid_at:new Date(),payment_method_id:null,payment_method:null,customer:{name:'QA'}}]},
    returnSettlement:{findMany:async()=>[]},customerPaymentRefund:{findMany:async()=>[]}}
  await withMocks({[require.resolve('../src/models/prisma')]:{prisma:db},[require.resolve('../src/utils/getTimezone')]:{getTimezone:async()=> 'America/Guatemala'}},require.resolve('../src/modules/cash-closure/controller'),async ctrl=>{
    const res=jsonResponse();await ctrl.calculateTheoretical({companyId:'A',branchId:'B',user:{sub:'U',role:{name:'admin'}},query:{startDate:'2026-10-15T00:00:00Z',endDate:'2026-10-16T00:00:00Z'}},res,e=>{throw e})
    assert.equal(res.body.theoretical.total_collections,25)
    assert.equal(res.body.theoretical.net_total,25)
    assert.deepEqual(res.body.payment_breakdown,[])
    assert.equal(res.body.collections[0].payment_method,null)
    assert.equal(res.body.unidentified_collections_amount,25)
  })
})
const defaults={cash:{id:'cash-account'},bank:{id:'bank-account'},receivables:{id:'ar-account'},sales:{id:'sales-account'},salesReturns:{id:'returns-account'},inventory:{id:'inventory-account'},cogs:{id:'cogs-account'}}
const options={defaults,splitVat:false,ivaRate:0,costBase:v=>v,pequenoTaxOf:()=>0}
for(const [kind,name,account] of [['CASH','Mostrador','cash-account'],['BANK','Efectivo digital','bank-account'],[null,'Cash','bank-account'],[null,'Efectivo','cash-account']])
test(`sale and refund posting honor ${kind} ${name}`,()=>{
  const method={id:11,name,is_credit:false,settlement_kind:kind}
  const lines=buildSalePosting({total:25,settlement_source:'LEGACY',sale_items:[],payment_method:method},options)
  assert.equal(lines.find(l=>l.debit===25).account_id,account)
  const refund=buildReturnPosting({total_refund:25,type:'REFUND',return_items:[],sale:{payment_method:method},settlements:[{kind:'REFUND',amount:25,payment_method:method}]},options)
  assert.equal(refund.find(l=>l.credit===25).account_id,account)
})
test('opening float uses authorized historical cash even when disabled',async()=>{
  const map=new Map()
  const db={companyPaymentMethod:{findMany:async({where})=>{
    assert.equal(where.company_id,'A');assert.equal(where.enabled,undefined)
    return [{enabled:false,position:0,payment_method:{id:3,name:'Mostrador',company_id:'A',settlement_kind:'CASH',is_credit:false}}]
  }}}
  assert.deepEqual(await applyOpeningFloatToCashBreakdown(db,'A',map,40),{openingFloat:40,cashSalesAmount:0})
  assert.equal(map.get(3).theoretical_amount,40);assert.equal(map.get(3).settlement_kind,'CASH')
})
test('refund breakdown keeps explicit type for disabled historical medium',()=>{
  const map=new Map()
  applyReturnSettlements(map,[{kind:'REFUND',amount:10,payment_method_id:7,payment_method:{name:'Efectivo digital',settlement_kind:'BANK'}}])
  assert.equal(map.get(7).theoretical_amount,-10);assert.equal(map.get(7).settlement_kind,'BANK')
})
