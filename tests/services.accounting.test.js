const test=require('node:test'),assert=require('node:assert/strict')
const {withMocks}=require('./helpers/reportHarness.cjs')
const engine=require.resolve('../src/services/accounting/postingEngine'),core=require.resolve('../src/services/accounting/core')
const defaults=Object.fromEntries(['cash','bank','receivables','sales','salesReturns','inventory','cogs','ivaDebit','pequenoTax','pequenoTaxExpense'].map(key=>[key,{id:key}]))
function balanced(lines){assert.equal(Math.round(lines.reduce((s,l)=>s+l.debit-l.credit,0)*100),0)}
test('accounting posts service income and refund without inventory cost even with contaminated costs',async()=>{
  const entries=[]
  const db={
    companyModule:{findMany:async()=>[]},
    $queryRaw:async(_parts,...values)=> values.includes('SALE') && !entries.length ? [{id:'v'}] : [],
    $transaction:async fn=>fn(db),
    sale:{findMany:async({where,select})=>{if(!where.id.in.length)return[];assert.equal(select.sale_items.select.item_kind,true);return[{id:'v',date:new Date(),total:150,payment_method:{name:'Efectivo'},sale_items:[{qty:'1.5',item_kind:'SERVICE',unit_cost:999,product:{kind:'STANDARD',cost:999}}]}]}},
  }
  for(const key of ['return','incomingMerchandise','incomingMerchandisePaymentEntry','customerPayment','cashClosure'])db[key]={findMany:async()=>[]}
  await withMocks({[core]:{...require(core),getDefaultAccounts:async()=>defaults,getTaxConfig:async()=>({regime:'PEQUENO',ivaRate:.12,pequenoRate:0}),createEntry:async(_tx,data)=>entries.push(data)}},engine,async api=>{
    await api.postPendingOperations(db,'U','A')
    assert.equal(entries.length,1)
    assert.deepEqual(entries[0].lines,[{account_id:'cash',debit:150,credit:0},{account_id:'sales',debit:0,credit:150}])
    balanced(entries[0].lines)
    await api.postPendingOperations(db,'U','A');assert.equal(entries.length,1)
    const refund=api.buildReturnPosting({total_refund:50,type:'REFUND',sale:{payment_method:{name:'Efectivo'}},return_items:[{qty_returned:'0.5',sale_item:{item_kind:'SERVICE',unit_cost:999},product:{kind:'STANDARD',cost:999}}]}, {defaults,splitVat:false,ivaRate:.12,costBase:x=>x,pequenoTaxOf:()=>0})
    assert.deepEqual(refund,[{account_id:'salesReturns',debit:50,credit:0},{account_id:'cash',debit:0,credit:50}]);balanced(refund)
    const mixed=api.buildReturnPosting({total_refund:70,type:'REFUND',sale:{payment_method:{name:'Efectivo'}},return_items:[{restock_qty:2,sale_item:{item_kind:'STANDARD',unit_cost:30}},{qty_returned:'0.5',sale_item:{item_kind:'SERVICE',unit_cost:999}}]}, {defaults,splitVat:false,ivaRate:.12,costBase:x=>x,pequenoTaxOf:()=>0})
    assert.equal(mixed.find(line=>line.account_id==='inventory').debit,60);balanced(mixed)
  })
})
test('a sale settled through existing engagement receipts debits receivables instead of cash again',async()=>{
  const entries=[],db={companyModule:{findMany:async()=>[]},$queryRaw:async(_parts,...values)=>values.includes('SALE')&&!entries.length?[{id:'v'}]:[],$transaction:async fn=>fn(db),
    sale:{findMany:async({where})=>where.id.in.length?[{id:'v',branch_id:'b',date:new Date(),total:40,settlement_source:'ENGAGEMENT_RECEIPTS',payment_method:{name:'Efectivo'},sale_items:[{qty:1,item_kind:'SERVICE'}]}]:[]}}
  for(const key of ['return','incomingMerchandise','incomingMerchandisePaymentEntry','customerPayment','cashClosure'])db[key]={findMany:async()=>[]}
  await withMocks({[core]:{...require(core),getDefaultAccounts:async()=>defaults,getTaxConfig:async()=>({regime:'PEQUENO',ivaRate:.12,pequenoRate:0}),createEntry:async(_tx,data)=>entries.push(data)}},engine,async api=>{
    await api.postPendingOperations(db,'U','A')
    assert.equal(entries[0].lines[0].account_id,'receivables')
    assert.equal(entries[0].lines.some(l=>l.account_id==='cash'||l.account_id==='bank'),false)
  })
})
