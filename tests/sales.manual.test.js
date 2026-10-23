const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto')
const {manualHarness}=require('./helpers/manualSalesHarness.cjs'),{withMocks}=require('./helpers/reportHarness.cjs')
const target=require.resolve('../src/modules/sales')+'/../manualSales.js'
async function run(fn){const h=manualHarness();await withMocks(h.mocks,target,api=>fn(api,h))}
test('manual preview resolves exact prices without requiring prices or creating a draft',()=>run(async(api,h)=>{
 const input=h.input();delete input.items[0].expected_unit_price
 const preview=await api.previewManualSale(h.db,h.scope,input)
 assert.equal(preview.items[0].unitPrice,'10.25');assert.equal(preview.total,'12.81');assert.equal(h.state.sales.length,0);assert.deepEqual(h.state.effects,[])
}))
test('manual draft freezes exact server lines without stock, money, debt method or fiscal effects',()=>run(async(api,h)=>{
 const input=h.input(),draft=await api.saveManualSale(h.db,h.scope,null,input)
 assert.equal(draft.status,'DRAFT');assert.equal(draft.total,'12.81');assert.equal(draft.items[0].qty,'1.25');assert.equal(draft.items[0].unitPrice,'10.25');assert(!JSON.stringify(draft).includes('unit_cost'))
 assert.deepEqual(h.state.effects,[]);assert.equal(h.state.sales[0].payment_method_id,null);assert.equal(h.state.sales[0].cash_register_session_id,null)
 const again=await api.saveManualSale(h.db,h.scope,null,input);assert.equal(again.id,draft.id);assert.equal(h.state.sales.length,1)
 await assert.rejects(api.saveManualSale(h.db,h.scope,null,{...input,customerName:'different'}),{code:'REQUEST_CONFLICT'})
}))
test('draft edits use expected version, preserve ID and reject stale or foreign scope',()=>run(async(api,h)=>{
 const draft=await api.saveManualSale(h.db,h.scope,null,h.input()),edit={...h.input(),expectedVersion:1,items:[{product_id:h.product.id,qty:'2',expected_unit_price:'10.25'}]}
 const changed=await api.saveManualSale(h.db,h.scope,draft.id,edit);assert.equal(changed.id,draft.id);assert.equal(changed.version,2);assert.equal(changed.total,'20.50')
 await assert.rejects(api.saveManualSale(h.db,h.scope,draft.id,{...edit,idempotencyKey:randomUUID()}),{code:'VERSION_CONFLICT'})
 for(const scope of [{...h.scope,companyId:randomUUID()},{...h.scope,branchId:randomUUID()},{...h.scope,userId:randomUUID(),permissions:['sales.create']}])await assert.rejects(api.readManualSale(h.db,scope,draft.id),e=>[400,404].includes(e.status))
 assert.deepEqual(h.state.effects,[])
}))
test('confirmation preserves the same draft, pending balance and price; concurrent replay has one effect',()=>run(async(api,h)=>{
 const draft=await api.saveManualSale(h.db,h.scope,null,h.input()),input={expectedVersion:1,idempotencyKey:randomUUID(),dueDate:'2099-01-01'}
 h.product.price='99'
 const [a,b]=await Promise.all([api.confirmManualSale(h.db,h.scope,draft.id,input),api.confirmManualSale(h.db,h.scope,draft.id,input)])
 assert.equal(a.id,draft.id);assert.equal(b.id,draft.id);assert.equal(a.status,'CONFIRMED');assert.equal(a.total,'12.81')
 assert.equal(h.state.sales[0].payment_status,'PENDING');assert.equal(h.state.sales[0].amount_received,null)
 assert.deepEqual(h.state.effects,['availability','stock','accounting']);assert.equal(h.state.history.filter(x=>x.action==='MANUAL_CONFIRMED').length,1)
 await assert.rejects(api.saveManualSale(h.db,h.scope,draft.id,{...h.input(),expectedVersion:2}),{code:'NOT_DRAFT'})
}))
test('credit disabled, bad customer and accounting failure keep the draft and all effects unchanged',()=>run(async(api,h)=>{
 const draft=await api.saveManualSale(h.db,h.scope,null,h.input()),input=()=>({expectedVersion:1,idempotencyKey:randomUUID(),dueDate:'2099-01-01'})
 h.settings.sales_allow_credit='false';await assert.rejects(api.confirmManualSale(h.db,h.scope,draft.id,input()),{code:'CREDIT_DISABLED'});h.settings.sales_allow_credit='true'
 h.customer.deleted=true;await assert.rejects(api.confirmManualSale(h.db,h.scope,draft.id,input()),{code:'INVALID_CUSTOMER'});h.customer.deleted=false
 await withMocks({...h.mocks,[require.resolve('../src/services/accounting/postingEngine')]:{postSaleInTransaction:async()=>{throw Error('closed period')}}},target,async service=>assert.rejects(service.confirmManualSale(h.db,h.scope,draft.id,input()),/closed period/))
 assert.equal(h.state.sales[0].status_id,1);assert.deepEqual(h.state.effects,[])
}))
test('cancelling draft does not restore unconsumed stock; Agenda source cannot be edited or confirmed',()=>run(async(api,h)=>{
 const draft=await api.saveManualSale(h.db,h.scope,null,h.input())
 h.state.sales[0].origin_engagement_id=randomUUID()
 await assert.rejects(api.readManualSale(h.db,h.scope,draft.id),{code:'SOURCE_OWNS_SALE'})
 await assert.rejects(api.confirmManualSale(h.db,h.scope,draft.id,{expectedVersion:1,idempotencyKey:randomUUID()}),{code:'SOURCE_OWNS_SALE'})
 h.state.sales[0].origin_engagement_id=null
 const cancelled=await api.cancelManualSale(h.db,h.scope,draft.id,{expectedVersion:1,idempotencyKey:randomUUID()});assert.equal(cancelled.status,'CANCELLED');assert.deepEqual(h.state.effects,[])
}))
test('untrusted state, price, conversion, zero quantity and missing permissions are rejected',()=>run(async(api,h)=>{
 for(const extra of [{status:'CONFIRMED'},{payment_method_id:1},{amount_received:'10'}])await assert.rejects(api.saveManualSale(h.db,h.scope,null,{...h.input(),...extra}),{status:400})
 for(const extra of [{price:'0'},{base_qty:'100'},{qty:'0'}])await assert.rejects(api.saveManualSale(h.db,h.scope,null,{...h.input(),items:[{...h.input().items[0],...extra}]}),{status:400})
 await assert.rejects(api.saveManualSale(h.db,h.scope,null,{...h.input(),items:[{product_id:h.product.id,qty:'1',expected_unit_price:'1'}]}),{code:'PRICE_CHANGED'})
 await assert.rejects(api.saveManualSale(h.db,{...h.scope,permissions:[]},null,h.input()),{status:403})
 await assert.rejects(api.saveManualSale(h.db,{...h.scope,branchId:'all'},null,h.input()),{status:400});assert.equal(h.state.sales.length,0)
}))
test('a cancelled manual draft cannot bypass credit and stock checks through generic status restoration',()=>{
 const {assertGenericSaleStatusChange}=require('../src/modules/sales/commercialState')
 assert.throws(()=>assertGenericSaleStatusChange({settlement_source:'MANUAL_SALE',status:{name:'Cancelada'}},'Completada'),{code:'MANUAL_SALE_ACTION_REQUIRED'})
})
test('confirmation freezes the current goods cost, not the cost when the draft was prepared',()=>run(async(api,h)=>{
 Object.assign(h.product,{kind:'STANDARD',price:'10.25',cost:'3.10',price_wholesale:null})
 const input={...h.input(),items:[{product_id:h.product.id,qty:'1',expected_unit_price:'10.25'}]}
 const draft=await api.saveManualSale(h.db,h.scope,null,input);h.product.cost='4.20'
 await api.confirmManualSale(h.db,h.scope,draft.id,{expectedVersion:1,idempotencyKey:randomUUID(),dueDate:'2099-01-01'})
 assert.equal(new (require('@prisma/client').Prisma.Decimal)(h.state.items[0].unit_cost).toFixed(2),'4.20')
}))
test('confirmation enforces method availability, due date and explicit credit override',()=>run(async(api,h)=>{
 const draft=await api.saveManualSale(h.db,h.scope,null,h.input()),input={expectedVersion:1,idempotencyKey:randomUUID(),dueDate:'2099-01-01'}
 h.customer.credit_limit=0;await assert.rejects(api.confirmManualSale(h.db,h.scope,draft.id,input),{code:'CREDIT_NOT_AVAILABLE'})
 await assert.rejects(api.confirmManualSale(h.db,h.scope,draft.id,{...input,creditOverride:true}),{code:'CREDIT_NOT_AVAILABLE'})
 h.customer.credit_limit=null;const original=h.db.companyPaymentMethod.findFirst;h.db.companyPaymentMethod.findFirst=async()=>null
 await assert.rejects(api.confirmManualSale(h.db,h.scope,draft.id,input),{code:'PM_KIND_INVALID'});h.db.companyPaymentMethod.findFirst=original
 await assert.rejects(api.confirmManualSale(h.db,h.scope,draft.id,{...input,dueDate:'2000-01-01'}),{status:400});assert.deepEqual(h.state.effects,[])
}))
test('draft rejects versions outside database integer range before any write',()=>run(async(api,h)=>{
 await assert.rejects(api.saveManualSale(h.db,h.scope,null,{...h.input(),expectedVersion:2147483648}),{status:400});assert.equal(h.state.sales.length,0)
}))
test('zero-total confirmation keeps a valid settlement condition without inventing cash received',()=>run(async(api,h)=>{
 h.product.price='0';const input=h.input();input.items[0].expected_unit_price='0'
 const draft=await api.saveManualSale(h.db,h.scope,null,input)
 await api.confirmManualSale(h.db,h.scope,draft.id,{expectedVersion:1,idempotencyKey:randomUUID()})
 assert.equal(h.state.sales[0].payment_method_id,1);assert.equal(h.state.sales[0].payment_status,'PAID');assert.equal(h.state.sales[0].amount_received,null)
}))
