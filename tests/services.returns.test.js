const test=require('node:test')
const assert=require('node:assert/strict')
const {availableReturnQty,normalizeReturnLines,refundFromLine}=require('../src/modules/returns/domain')
const {buildCompletionPlan,approveReturn,completeReturn}=require('../src/modules/returns/application')
const original={id:1,product_id:'s',item_kind:'SERVICE',item_name:'Asesoría',unit_label:'Hora',quantity_decimals:2,qty:'1.5'}
test('service return uses original precision and exact remaining quantity and amount',()=>{
  assert.equal(String(availableReturnQty('1.5',[{qty_returned:'0.5',status:'Completada'}])),'1')
  assert.equal(String(availableReturnQty('0.3',[{qty_returned:'0.2',status:'Completada'}])),'0.1')
  assert.equal(normalizeReturnLines([{sale_item_id:1,product_id:'s',qty_returned:'0.5'}],[original])[0].qty_returned,'0.5')
  assert.throws(()=>normalizeReturnLines([{sale_item_id:1,product_id:'s',qty_returned:'0.501'}],[original]),/decimal/i)
  assert.equal(refundFromLine({originalQty:'1.5',lineNet:'150',qty:'0.5',returnedQty:'0',returnedAmount:0}),50)
  assert.equal(refundFromLine({originalQty:'3',lineNet:'10',qty:'1',returnedQty:'2',returnedAmount:'6.66'}),3.34)
  assert.throws(()=>refundFromLine({originalQty:'1.5',lineNet:150,qty:'1.01',returnedQty:'0.5',returnedAmount:50}),/disponible|pendiente/i)
})
test('return eligibility exposes original service metadata and exact refund balance',async()=>{
  const {withMocks,jsonResponse}=require('./helpers/reportHarness.cjs')
  const model=require.resolve('../src/models/prisma'),target=require.resolve('../src/modules/returns/controller')
  const db={systemSetting:{findUnique:async()=>null},sale:{findMany:async({select})=>{
    for(const field of ['item_kind','item_name','unit_label','quantity_decimals','net_total']) assert.equal(select.sale_items.select[field],true,field)
    return[{id:'v',date:new Date(),total:150,status:{name:'Completada'},sale_items:[{...original,price:100,net_total:150,product:{id:'s',name:'Unidad cambiada'},return_items:[{qty_returned:'0.5',refund_amount:50,return:{status:{name:'Completada'}}}]}]}]
  }}}
  await withMocks({[model]:{prisma:db,prismaTransaction:db}},target,async controller=>{
    const res=jsonResponse(); await controller.eligibleSales({companyId:'A',branchId:'B',query:{}},res,e=>{throw e})
    assert.equal(res.body.items[0].sale_items[0].unit_label,'Hora')
    assert.equal(String(res.body.items[0].sale_items[0].available_to_return),'1')
    assert.equal(res.body.items[0].sale_items[0].refundable_amount,100)
  })
})
test('service approval and completion have no physical disposition and reject injected reception',()=>{
  const record={status:{name:'Aprobada'},approved_resolution:'REFUND_ORIGINAL',total_refund:50,sale:{total:150,total_returned:0},return_items:[{id:1,product_id:'s',qty_returned:'0.5',sale_item:original}]}
  const plan=buildCompletionPlan(record,{idempotency_key:'return-service',lines:[{return_item_id:1}]})
  assert.equal(plan.lines[0].received_qty,null)
  assert.equal(plan.lines[0].restock_qty,null)
  assert.equal(plan.lines[0].stock_location_id,null)
  assert.throws(()=>buildCompletionPlan(record,{idempotency_key:'return-service',lines:[{return_item_id:1,received_qty:1,disposition:'SELLABLE',stock_location_id:'L'}]}),/servicio/i)
})
test('an explicit sale ID cannot expose a draft in return eligibility',async()=>{
  const {withMocks,jsonResponse}=require('./helpers/reportHarness.cjs')
  const model=require.resolve('../src/models/prisma'),target=require.resolve('../src/modules/returns/controller')
  const db={systemSetting:{findUnique:async()=>null},sale:{findFirst:async()=>({id:'draft-id'}),findMany:async({where})=>{assert.deepEqual(where.status,{name:'Completada'});return []}}}
  await withMocks({[model]:{prisma:db,prismaTransaction:db}},target,async controller=>{
    const res=jsonResponse();await controller.eligibleSales({companyId:'A',branchId:'B',query:{sale_id:'draft-id'}},res,e=>{throw e})
    assert.equal(res.body.totalItems,0)
  })
})
test('linked receipt sales cannot fabricate a paid replacement sale through the legacy exchange shortcut',()=>{
  const record={status:{name:'Aprobada'},approved_resolution:'EXCHANGE',total_refund:30,sale:{total:100,total_returned:0,settlement_source:'ENGAGEMENT_RECEIPTS'},return_items:[{id:1,product_id:'s',qty_returned:'0.3',sale_item:original}]}
  assert.throws(()=>buildCompletionPlan(record,{idempotency_key:'linked-exchange',lines:[{return_item_id:1}]}),/saldo a favor|devolución/i)
})
test('historical service refund approves and settles once with no stock facilities or feature flag',async()=>{
  let record={id:'R',type:'REFUND',status:{name:'Pendiente'},requested_resolution:'REFUND_ORIGINAL',approved_resolution:null,total_refund:50,return_items:[{id:1,sale_item_id:1,product_id:'s',qty_returned:'0.5'}],sale:{id:'v',branch_id:'B',total:150,adjusted_total:150,total_returned:0,payment_method_id:1,payment_method:{name:'Efectivo',is_credit:false},sale_items:[original]}}
  const settlements=[]
  // Full transaction boundary for scoped payment availability.
  const tx={$queryRaw:async()=>[{id:'R'}],return:{findFirst:async()=>record,update:async({data})=>{record={...record,...data,status:{name:data.status_id===2?'Aprobada':'Completada'}};return record}},returnStatus:{findFirst:async({where})=>({id:where.name==='Aprobada'?2:3,name:where.name})},returnItem:{update:async({data})=>Object.assign(record.return_items[0],data)},sale:{update:async({data})=>Object.assign(record.sale,data)},returnSettlement:{findFirst:async()=>settlements[0] || null,create:async({data})=>{const row={id:'settlement',...data};settlements.push(row);return row}},paymentMethod:{findUnique:async()=>({id:1,name:'Efectivo'})},cashRegisterSession:{findFirst:async()=>({id:'CS'})}}
  await approveReturn(tx,{id:'R',scope:{branch_id:'B'},companyId:'A',resolution:'REFUND_ORIGINAL',lines:[{return_item_id:1}],policy:{enabledResolutions:['REFUND_ORIGINAL']}})
  const params={id:'R',scope:{branch_id:'B'},companyId:'A',payload:{idempotency_key:'once',lines:[{return_item_id:1}],settlement:{payment_method_id:1,cash_register_session_id:'CS'}}}
  const client={$transaction:fn=>fn(tx)}
  tx.$executeRaw=async()=>0
  tx.companyPaymentMethod={findFirst:async()=>({enabled:true,payment_method:{id:1,name:'Efectivo',is_credit:false}})}
  await completeReturn(client,params)
  assert.equal(record.sale.adjusted_total,100)
  assert.equal(record.return_items[0].restock_qty,null)
  assert.equal(settlements[0].amount,50)
  assert.equal((await completeReturn(client,params))._idempotent,true)
  assert.equal(settlements.length,1)
})
