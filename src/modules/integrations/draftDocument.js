const {uuid,fail,object}=require('./credentials')
const {parseQuantity,parseDecimal}=require('../../services/units/quantity')
const {validateSnapshot}=require('../inventory/units/calculation')
const {choice,integer,text}=require('../appointments/domain/validation')
const {lockCommercialDocument}=require('../../services/commercialDocumentConcurrency')
const exists={select:{id:true},take:1}
const privateSelect=Object.fromEntries(['id','reference','doc_type','status','branch_id','subtotal','discount_total','total','updated_at','integration_revision','sales_channel','payment_condition','credit_days','public_token','confirmed_at','converted_from_id','customer_contact_id','delivery_carrier','delivery_tracking_number','delivery_address','delivery_dispatched_at','delivery_estimated_at','package_groups'].map(k=>[k,true]))
Object.assign(privateSelect,{convertedFrom:{select:{id:true}},convertedChildren:exists,stock_reservations:exists,documentSales:exists,deliveries:exists,quoted_engagement:{select:{id:true}},ordered_engagement:{select:{id:true}},lines:{select:{id:true,item_kind:true,qty:true,qty_fulfilled:true,qty_invoiced:true,base_fulfilled:true,base_invoiced:true,base_unit_cost:true,unit_metadata_version:true,unit_snapshot:true,service_schedule_snapshot:true,package_component_key:true,engagement_lines:exists,deliveryLines:exists,reservations:exists}}})

function formatDocumentVersion(revision){
 if(!uuid(revision))fail(503,'UNAVAILABLE')
 return 'auna-draft-v1:'+revision.toLowerCase()
}
async function loadOwnedDraft(tx,context,type,id,{lock=false}={}){
 if(!uuid(id)||!['QUOTE','ORDER'].includes(type))fail(404,'NOT_FOUND')
 const where={company_id:context.companyId,integration_id:context.integrationId,type,document_id:id.toLowerCase(),branch_id:{in:context.branches.map(b=>b.id)},document:{doc_type:type,branch_id:{in:context.branches.map(b=>b.id)}}}
 if(lock){
  const origin=await tx.integrationDraftOperation.findFirst({where,select:{branch_id:true}})
  if(!origin||!await lockCommercialDocument(tx,{companyId:context.companyId,branchId:origin.branch_id,type},id.toLowerCase()))fail(404,'NOT_FOUND')
 }
 const operation=await tx.integrationDraftOperation.findFirst({where,select:{id:true,currency_code:true,document:{select:{...privateSelect,...require('../../services/eventPaymentTermsStorage').eventPaymentSelect(tx)}}}})
 if(!operation?.document)fail(404,'NOT_FOUND')
 return{operation,document:operation.document}
}
function review(){fail(409,'DOCUMENT_REVIEW_REQUIRED')}
function keys(value,allowed){object(value,allowed)}
function historicalLine(line){
 if(line.base_unit_cost!=null)review()
 const unit=line.unit_snapshot
 if(line.unit_metadata_version===1){
  if(unit!==null&&unit!==undefined){keys(unit,['version','factor','unit_label']);if(unit.version!==1)review();parseQuantity(unit.factor,{decimals:12});text(unit.unit_label,'unit_label',50)}
 }else if(line.unit_metadata_version===2){
  keys(unit,['version','baseUnit','presentation','factor','roundingDelta'])
  keys(unit.baseUnit,['id','code','name','label','decimals'])
  if(unit.presentation!==null)keys(unit.presentation,['id','version','name','label','decimals'])
  validateSnapshot(unit,{kind:line.item_kind,base_unit_id:unit.baseUnit.id})
 }else review()
 const service=line.service_schedule_snapshot
 if(service!=null){
  keys(service,['version','schedulingStyle','durationPolicy','durationMinutes','allowedVenueKinds','publicInstructions','assignmentRequirements'])
  if(service.version!==1||line.item_kind!=='SERVICE')review()
  choice(service.schedulingStyle,'schedulingStyle',['APPOINTMENT','CLASS','WORK']);choice(service.durationPolicy,'durationPolicy',['FIXED','EDITABLE'])
  integer(service.durationMinutes,'durationMinutes',1,service.schedulingStyle==='WORK'?44640:1440)
  if(!Array.isArray(service.allowedVenueKinds)||!service.allowedVenueKinds.length||service.allowedVenueKinds.length>4)review()
  service.allowedVenueKinds.forEach(v=>choice(v,'allowedVenueKinds',['BRANCH','HOME','EVENT_VENUE','ONLINE']))
  text(service.publicInstructions,'publicInstructions',2000,false)
  if(service.assignmentRequirements!==undefined){
    if(!Array.isArray(service.assignmentRequirements)||service.assignmentRequirements.length>20)review()
    let places=0
    for(const requirement of service.assignmentRequirements){
      keys(requirement,['name','kind','quantity','attendanceMode']);text(requirement.name,'name',100);choice(requirement.kind,'kind',['PROVIDER','RESOURCE'])
      if(requirement.attendanceMode!==undefined){choice(requirement.attendanceMode,'attendanceMode',['FULL','INTERVENTION']);if(requirement.attendanceMode==='INTERVENTION'&&service.schedulingStyle!=='WORK')review()}
      places+=integer(requirement.quantity,'quantity',1,20)
    }
    if(places>40)review()
  }
 }
}
function assertMutableDraft(document,{replaceItems=false}={}){
 try{
  if(document?.package_groups!=null&&(!Array.isArray(document.package_groups)||document.package_groups.length)||document?.lines?.some(line=>line.package_component_key))review()
  if(!document||document.status!=='DRAFT'||document.sales_channel!=='ONLINE'||document.payment_condition!=='CASH'||document.credit_days!=null&&document.credit_days!==0||parseDecimal(document.discount_total??'0',{allowZero:true}).gt(0)||!document.customer_contact_id)review()
  for(const field of ['converted_from_id','convertedFrom','quoted_engagement','ordered_engagement','public_token','confirmed_at','delivery_carrier','delivery_tracking_number','delivery_address','delivery_dispatched_at','delivery_estimated_at'])if(document[field]!=null&&document[field]!=='')review()
  for(const field of ['convertedChildren','stock_reservations','documentSales','deliveries'])if(document[field]?.length)review()
  for(const line of document.lines??[]){
   for(const field of ['qty_fulfilled','qty_invoiced','base_fulfilled','base_invoiced'])if(parseDecimal(line[field]??'0',{allowZero:true}).gt(0))review()
   for(const field of ['engagement_lines','deliveryLines','reservations'])if(line[field]?.length)review()
   if(replaceItems)historicalLine(line)
  }
 }catch{review()}
}
module.exports={formatDocumentVersion,loadOwnedDraft,assertMutableDraft}
