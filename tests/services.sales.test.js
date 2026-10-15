const test=require('node:test')
const assert=require('node:assert/strict')
const {resolvePricedSaleItems}=require('../src/modules/sales/application')
const service={id:'s',name:'Asesoría',kind:'SERVICE',service_unit_label:'Hora',quantity_decimals:2,available_for_sale:true,price:100,cost:0}
const good={id:'b',name:'Bien',kind:'STANDARD',available_for_sale:true,price:10,cost:4}
function fixture(){return {product:{findMany:async({where})=>{assert.equal(where.company_id,'A');return [service,good].filter(item=>where.id.in.includes(item.id))}},supplier:{findFirst:async()=>null},systemSetting:{findUnique:async()=>({value:'true'}),findMany:async()=>[]}}}
test('service sales preserve decimals and snapshots, never query stock and calculate rounded money exactly',async()=>{
  const tx=fixture()
  const lines=await resolvePricedSaleItems(tx,{items:[{product_id:'s',qty:'1.5'}],companyId:'A',branchId:'B',availability:async()=>assert.fail('No physical availability')})
  assert.equal(String(lines[0].qty),'1.5')
  assert.equal(lines[0].line_total,150)
  assert.equal(lines[0].unit_cost,0)
  assert.equal(lines[0].item_kind,'SERVICE')
  assert.equal(lines[0].unit_label,'Hora')
  tx.product.findMany=async()=>[{...service,price:'19.99'}]
  assert.equal((await resolvePricedSaleItems(tx,{items:[{product_id:'s',qty:'1.25'}],companyId:'A'}))[0].line_total,24.99)
})
test('mixed and forged service flags keep physical stock checks and service setting enforcement',async()=>{
  const tx=fixture()
  const availability=async ids=>{assert.deepEqual(ids,['b']);return{b:{available:1}}}
  await assert.rejects(resolvePricedSaleItems(tx,{items:[{product_id:'s',qty:'0.75'},{product_id:'s',qty:'0.75'},{product_id:'b',qty:2,is_service:true}],companyId:'A',branchId:'B',availability}),/Stock insuficiente/i)
  await assert.rejects(resolvePricedSaleItems(tx,{items:[{product_id:'b',qty:'0.5'}],companyId:'A',branchId:'B',availability}),/decimal/i)
  tx.systemSetting.findUnique=async()=>({value:'false'})
  await assert.rejects(resolvePricedSaleItems(tx,{items:[{product_id:'s',qty:'1.5'}],companyId:'A'}),error=>error.status===403)
})
test('approved replacement retains its own original unit and precision after catalog changes',async()=>{
  const tx=fixture()
  tx.product.findMany=async()=>[{...service,service_unit_label:'Sesión',quantity_decimals:0}]
  const approved=[{product_id:'s',qty:'1.25',item_name:'Asesoría aprobada',item_kind:'SERVICE',unit_label:'Hora',quantity_decimals:2}]
  const lines=await resolvePricedSaleItems(tx,{items:[{product_id:'s',qty:'1.25'}],approvedSnapshots:approved,companyId:'A'})
  assert.equal(lines[0].unit_label,'Hora')
  assert.equal(lines[0].item_name,'Asesoría aprobada')
  assert.equal(lines[0].qty,'1.25')
  tx.systemSetting.findUnique=async()=>({value:'false'})
  await assert.rejects(resolvePricedSaleItems(tx,{items:[{product_id:'s',qty:'1.25'}],approvedSnapshots:approved,companyId:'A'}),error=>error.status===403)
})
for(const felEnabled of [false,true])test(`direct POS service sale keeps cash checks and one fiscal request when enabled=${felEnabled}`,async()=>{
  const {withMocks,jsonResponse}=require('./helpers/reportHarness.cjs')
  const model=require.resolve('../src/models/prisma')
  const target=require.resolve('../src/modules/sales/controller')
  const payments=require.resolve('../src/services/commercialPayment')
  const reference=require.resolve('../src/services/referenceGenerator')
  let stored=null,paymentCount=0,lines=[],documents=[],history=[]
  const tx={...fixture(),branch:{findUnique:async()=>({id:'B',code:'QA'})},cashRegister:{findFirst:async()=>({id:'C'})},cashRegisterSession:{findFirst:async()=>({id:'CS',opened_by_id:'U'})},saleStatus:{findFirst:async()=>({id:1})},paymentMethod:{findUnique:async()=>({id:1,name:'Efectivo',is_credit:false})},
    sale:{findFirst:async()=>stored,create:async({data})=>{stored={id:'V',version:1,status:{name:'Completada'},sale_dtes:documents,...data};return stored},update:async({data})=>{stored.version+=data.version.increment;return stored}},saleItem:{createMany:async({data})=>{lines=data;stored.sale_items=data}},$transaction:async run=>run(tx),
    saleDte:{create:async({data})=>{assert.equal(data.company_id,'A');assert.equal(data.branch_id,'B');const doc={id:'doc',...data};documents.push(doc);return doc}},saleHistory:{create:async({data})=>{history.push(data);return data}}}
  tx.systemSetting.findMany=async({where})=>where.key==='fel_enabled'&&felEnabled?[{value:'true'}]:[]
  await withMocks({[model]:{prisma:tx,prismaTransaction:tx},[reference]:{nextDocumentReference:async()=> 'V-QA-1'},[payments]:{...require(payments),recordInitialPayment:async()=>{paymentCount++}}},target,async controller=>{
    const req={companyId:'A',branchId:'B',user:{sub:'U'},body:{items:[{product_id:'s',qty:'1.5'}],payment_method_id:1,cash_register_id:'C',idempotency_key:'service-attempt',sales_channel:'WHOLESALE'}}
    const res=jsonResponse()
    await controller.create(req,res,error=>{throw error})
    assert.equal(res.statusCode,201)
    assert.equal(stored.items,0)
    assert.equal(stored.total,150)
    assert.equal(lines[0].unit_label,'Hora')
    assert.equal(String(lines[0].qty),'1.5')
    const retry=jsonResponse()
    await controller.create(req,retry,error=>{throw error})
    assert.equal(retry.statusCode,200)
    assert.equal(retry.body.id,'V')
    assert.equal(paymentCount,1)
    assert.equal(documents.length,felEnabled?1:0);assert.equal(history.length,felEnabled?1:0)
    if(felEnabled){assert.equal(documents[0].status,'PENDING_CONNECTOR');assert.equal(documents[0].authorization,undefined);assert.equal(history[0].after.source,'POS');assert.equal(retry.body.commercial.fiscalState,'PENDING_CONNECTOR')}
  })
})
