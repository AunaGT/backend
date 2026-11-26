const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto')
const ID='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const base=()=>({id:ID,status:'DRAFT',sales_channel:'ONLINE',payment_condition:'CASH',credit_days:null,discount_total:'0',customer_contact_id:ID,lines:[{item_kind:'STANDARD',qty:'1',qty_fulfilled:'0',qty_invoiced:'0',base_fulfilled:'0',base_invoiced:'0',base_unit_cost:null,unit_metadata_version:1,unit_snapshot:{version:1,factor:'1',unit_label:'unidad'},service_schedule_snapshot:null}],convertedChildren:[],stock_reservations:[],documentSales:[],deliveries:[]})
test('existing API drafts accept saved public requirements but reject private or malformed options',()=>{
 const {assertMutableDraft}=require('../src/modules/integrations/draftDocument')
 const summary={name:'Personal',kind:'PROVIDER',quantity:2}
 const doc={...base(),lines:[{...base().lines[0],item_kind:'SERVICE',service_schedule_snapshot:{version:1,schedulingStyle:'WORK',durationPolicy:'FIXED',durationMinutes:60,allowedVenueKinds:['BRANCH'],publicInstructions:'',assignmentRequirements:[summary]}}]}
 assert.doesNotThrow(()=>assertMutableDraft(doc,{replaceItems:true}))
 for(const attendanceMode of ['FULL','INTERVENTION']){
  const changed=structuredClone(doc);changed.lines[0].service_schedule_snapshot.assignmentRequirements[0].attendanceMode=attendanceMode
  assert.doesNotThrow(()=>assertMutableDraft(changed,{replaceItems:true}))
 }
 for(const requirement of [{...summary,optionIds:[ID]},{...summary,quantity:0},{...summary,quantity:21},{...summary,kind:'ANY'},{...summary,name:'x'.repeat(101)}]){
  const changed=structuredClone(doc);changed.lines[0].service_schedule_snapshot.assignmentRequirements=[requirement]
  assert.throws(()=>assertMutableDraft(changed,{replaceItems:true}),{status:409})
 }
})
test('protected header/line relations and fulfillment block mutation in every state',()=>{
 const {assertMutableDraft}=require('../src/modules/integrations/draftDocument')
 assert.doesNotThrow(()=>assertMutableDraft(base(),{replaceItems:true}))
 for(const change of [{status:'SENT'},{status:'CANCELLED'},{converted_from_id:ID},{convertedFrom:{id:ID}},{convertedChildren:[{id:ID}]},{stock_reservations:[{id:ID,status:'RELEASED'}]},{documentSales:[{id:ID}]},{deliveries:[{id:ID}]},{quoted_engagement:{id:ID}},{ordered_engagement:{id:ID}},{sales_channel:'POS'},{payment_condition:'CREDIT'},{credit_days:1},{discount_total:'0.01'},{public_token:'token'},{confirmed_at:new Date()},{delivery_address:'private'},{delivery_carrier:'private'},{delivery_tracking_number:'private'},{delivery_dispatched_at:new Date()},{delivery_estimated_at:new Date()},{customer_contact_id:null}])assert.throws(()=>assertMutableDraft({...base(),...change}),{status:409,integrationCode:'DOCUMENT_REVIEW_REQUIRED'})
 for(const change of [{qty_fulfilled:'0.1'},{qty_invoiced:'1'},{base_fulfilled:'1'},{base_invoiced:'1'},{engagement_lines:[{id:ID}]},{deliveryLines:[{id:ID}]},{reservations:[{id:ID,status:'RELEASED'}]}])assert.throws(()=>assertMutableDraft({...base(),lines:[{...base().lines[0],...change}]}),{status:409})
})
test('item replacement rejects private or malformed historical snapshots; notes-only preserves them',()=>{
 const {assertMutableDraft}=require('../src/modules/integrations/draftDocument')
 for(const change of [{base_unit_cost:'0'},{unit_snapshot:{version:1,factor:'1',unit_label:'unidad',cost:'5'}},{unit_snapshot:{version:1,factor:'bad',unit_label:'unidad'}},{unit_metadata_version:3},{service_schedule_snapshot:{version:1,private:true}}]){
  const doc={...base(),lines:[{...base().lines[0],...change}]}
  assert.doesNotThrow(()=>assertMutableDraft(doc))
  assert.throws(()=>assertMutableDraft(doc,{replaceItems:true}),{status:409})
 }
 const snapshot={version:2,baseUnit:{id:ID,code:'kg',name:'Kilogramo',label:'kg',decimals:3},presentation:{id:randomUUID(),version:1,name:'Caja',label:'caja',decimals:0},factor:'10',roundingDelta:'0'}
 const doc={...base(),lines:[{...base().lines[0],unit_metadata_version:2,unit_snapshot:snapshot,base_qty:'10'}]}
 assert.doesNotThrow(()=>assertMutableDraft(doc,{replaceItems:true}))
 for(const unit_snapshot of [{...snapshot,cost:'private'},{...snapshot,baseUnit:{...snapshot.baseUnit,private:true}},{...snapshot,presentation:{...snapshot.presentation,price:'20'}}])assert.throws(()=>assertMutableDraft({...doc,lines:[{...doc.lines[0],unit_snapshot}]},{replaceItems:true}),{status:409})
})
