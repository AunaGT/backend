const Units=require('../units')
const {error}=require('./access')
const selectionKey=(id,presentationId)=>presentationId?id+':'+presentationId:id
// Called only after the existing label permission/scope checks and product locks.
async function resolveLabelSelection(tx,scope,product,item,enabled){
 if(!enabled){if(item.presentation_id!=null||item.unit_revision!==undefined)error(409,'UNITS_DISABLED','Las presentaciones están desactivadas',product.id);return {...product,selectionId:product.id}}
 const p=await tx.product.findFirst({where:{id:product.id,company_id:scope.companyId,deleted:false},select:{id:true,base_unit_id:true,unit_metadata_version:true,quantity_decimals:true,unit_revision:true}})
 if(!p)error(404,'PRODUCT_UNAVAILABLE','Producto no disponible',product.id)
 if(!Units.advancedProduct(p)){if(item.presentation_id!=null)error(409,'UNIT_METADATA_REVIEW_REQUIRED','Configura primero la unidad base',product.id);return {...product,selectionId:product.id}}
 Units.revision(p,item.unit_revision)
 const base=await tx.measureUnit.findFirst({where:{id:p.base_unit_id,company_id:scope.companyId}})
 if(!base)error(409,'UNIT_METADATA_REVIEW_REQUIRED','Revisa la unidad base antes de imprimir',product.id)
 const presentation=item.presentation_id==null?null:await tx.productPresentation.findFirst({where:{id:item.presentation_id,company_id:scope.companyId,product_id:p.id,active:true,sale_enabled:true}})
 if(item.presentation_id!=null&&!presentation)error(404,'PRESENTATION_UNAVAILABLE','La presentación no está disponible para venta',product.id)
 const factor=presentation?Units.factorText(presentation.factor):'1',label=presentation?.label??base.label
 const codes=presentation?await tx.productBarcode.findMany({where:{company_id:scope.companyId,product_id:p.id,presentation_id:presentation.id,active:true},orderBy:{code:'asc'}}):[]
 if(codes.length>1)error(409,'BARCODE_REVIEW_REQUIRED','La presentación tiene varios códigos; revisa su configuración',product.id)
 const selected={...product,presentation_id:presentation?.id??null,unit_revision:p.unit_revision,selectionId:selectionKey(p.id,presentation?.id),barcode:presentation?codes[0]?.code??null:product.barcode,name:product.name+' · '+label,unit_label:label,unit_snapshot:{version:2,baseUnit:{id:base.id,code:base.code,name:base.name,label:base.label,decimals:p.quantity_decimals},presentation:presentation?{id:presentation.id,name:presentation.name,label:presentation.label,version:presentation.version,decimals:presentation.quantity_decimals}:null,factor,roundingDelta:'0'}}
 selected.price=Units.unitPrice(product,presentation,'LIST',factor)
 for(const [tier,key] of [['WHOLESALE','price_wholesale'],['PROMOTION','price_promotion']]){
  const override=presentation?.[key],basePrice=product[key]
  const active=row=>tier!=='PROMOTION'||!row?.promotion_valid_until||new Date(row.promotion_valid_until)>=new Date()
  const source=override!=null&&active(presentation)?presentation:basePrice!=null&&active(product)?product:null
  selected[key]=source?Units.unitPrice(product,source===presentation?presentation:null,tier,factor):null
  if(tier==='PROMOTION')selected.promotion_valid_until=source?.promotion_valid_until??null
 }
 return selected
}
module.exports={resolveLabelSelection,selectionKey}
