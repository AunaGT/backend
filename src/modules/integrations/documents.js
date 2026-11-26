const {Prisma}=require('@prisma/client')
const {object,uuid,fail}=require('./credentials')
const {publicUnitLine}=require('../../services/units/publicLine')
const {formatDocumentVersion}=require('./draftDocument')
const {publicPackageGroups}=require('../../services/commercialPackages')
const statuses={QUOTE:['DRAFT','SENT','ACCEPTED','REJECTED','CANCELLED','EXPIRED'],ORDER:['DRAFT','CONFIRMED','PARTIALLY_FULFILLED','FULFILLED','CANCELLED','EXPIRED']}
const summarySelect={id:true,reference:true,doc_type:true,status:true,branch_id:true,subtotal:true,discount_total:true,total:true,created_at:true,valid_until:true}
const lineSelect={product_id:true,item_name:true,qty:true,unit_label:true,unit_price:true,line_total:true,unit_metadata_version:true,unit_snapshot:true,base_qty:true,package_component_key:true}
const money=v=>new Prisma.Decimal(String(v??'0')).toFixed(2),decimal=v=>new Prisma.Decimal(String(v)).toFixed()
function scope(context,type){if(!statuses[type]||!context.scopes.includes(type==='QUOTE'?'quotes.read':'orders.read'))fail(403,'FORBIDDEN');return{company_id:context.companyId,integration_id:context.integrationId,type,branch_id:{in:context.branches.map(b=>b.id)},document:{doc_type:type,branch_id:{in:context.branches.map(b=>b.id)}}}}
function dto(row){const d=row.document;return{id:d.id,reference:d.reference,type:d.doc_type,status:d.status,branchId:d.branch_id,externalReference:row.external_reference??null,subtotal:money(d.subtotal),discountTotal:money(d.discount_total),total:money(d.total),currency:row.currency_code,createdAt:new Date(d.created_at).toISOString(),validUntil:d.valid_until?new Date(d.valid_until).toISOString():null}}
async function listIntegrationDocuments(db,context,type,query={}){
 const where=scope(context,type);object(query,['limit','cursor','status'])
 const limit=Number(query.limit??25);if(!Number.isInteger(limit)||limit<1||limit>100)fail(400)
 if(query.cursor!==undefined){if(!uuid(query.cursor))fail(400);where.document_id={gt:query.cursor.toLowerCase()}}
 if(query.status!==undefined){if(!statuses[type].includes(query.status))fail(400);where.document.status=query.status}
 const rows=await db.integrationDraftOperation.findMany({where,select:{currency_code:true,external_reference:true,document:{select:summarySelect}},orderBy:{document_id:'asc'},take:limit+1}),items=rows.slice(0,limit)
 return{items:items.map(dto),nextCursor:rows.length>limit?items.at(-1).document.id:null}
}
async function getIntegrationDocument(db,context,type,id){
 const where=scope(context,type);if(!uuid(id))fail(404,'NOT_FOUND')
 return db.$transaction(async tx=>{
 const row=await tx.integrationDraftOperation.findFirst({where:{...where,document_id:id.toLowerCase()},select:{currency_code:true,external_reference:true,document:{select:{...summarySelect,updated_at:true,integration_revision:true,package_groups:true,lines:{select:lineSelect,orderBy:[{sort_order:'asc'},{id:'asc'}]}}}}})
 if(!row)fail(404,'NOT_FOUND')
 return{...dto(row),...(row.document.package_groups?.length?{packageGroups:publicPackageGroups(row.document.package_groups)}:{}),version:formatDocumentVersion(row.document.integration_revision),updatedAt:new Date(row.document.updated_at).toISOString(),items:row.document.lines.map(line=>{let publicLine;try{publicLine=publicUnitLine(line)}catch{fail(409,'UNIT_REVIEW_REQUIRED')};return{...(line.package_component_key?{packageComponentKey:line.package_component_key}:{}),productId:line.product_id,name:line.item_name,quantity:decimal(line.qty),unitLabel:line.unit_label,unitPrice:decimal(line.unit_price),lineTotal:money(line.line_total),unitMetadataVersion:line.unit_metadata_version,...(publicLine.unit_snapshot?{unitSnapshot:publicLine.unit_snapshot,baseQuantity:publicLine.base_qty}:{})}})}
 },{isolationLevel:'RepeatableRead',maxWait:15000,timeout:30000})
}
module.exports={listIntegrationDocuments,getIntegrationDocument}
