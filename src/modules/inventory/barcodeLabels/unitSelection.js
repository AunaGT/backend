const Units=require('../units')
const {error}=require('./access')
const selectionKey=(id,presentationId)=>presentationId?id+':'+presentationId:id
const configFields={company_id:true,base_unit_id:true,unit_metadata_version:true,quantity_decimals:true,unit_revision:true}
async function loadLabelUnitContext(db,scope,products,enabled,now=new Date()){
 if(products.some(p=>p.company_id&&p.company_id!==scope.companyId))error(403,'FORBIDDEN','Producto fuera del alcance')
 const context={companyId:scope.companyId,enabled,now,products:new Map(products.map(p=>[p.id,{...p}])),bases:new Map(),presentations:new Map(),presentationsByProduct:new Map(),codes:new Map()}
 const advanced=enabled?products.filter(Units.advancedProduct):[]
 if(!advanced.length)return context
 const ids=[...new Set(advanced.map(p=>p.id))],baseIds=[...new Set(advanced.map(p=>p.base_unit_id).filter(Boolean))]
 const [bases,presentations,codes]=await Promise.all([
  baseIds.length?db.measureUnit.findMany({where:{company_id:scope.companyId,id:{in:baseIds}},select:{id:true,code:true,name:true,label:true}}):[],
  db.productPresentation.findMany({where:{company_id:scope.companyId,product_id:{in:ids},active:true,sale_enabled:true},orderBy:{name:'asc'},select:{id:true,product_id:true,name:true,label:true,factor:true,version:true,quantity_decimals:true,price:true,price_wholesale:true,price_promotion:true,promotion_valid_until:true}}),
  db.productBarcode.findMany({where:{company_id:scope.companyId,product_id:{in:ids},active:true},orderBy:{code:'asc'},select:{product_id:true,presentation_id:true,code:true}}),
 ])
 for(const base of bases)context.bases.set(base.id,base)
 for(const p of presentations){context.presentations.set(p.id,p);const list=context.presentationsByProduct.get(p.product_id)??[];list.push(p);context.presentationsByProduct.set(p.product_id,list)}
 for(const code of codes){const key=selectionKey(code.product_id,code.presentation_id),list=context.codes.get(key)??[];list.push(code);context.codes.set(key,list)}
 return context
}
// Called only after the existing label permission/scope checks and product locks.
async function resolveLabelSelection(tx,scope,product,item,enabled,context){
 if(context&&(context.companyId!==scope.companyId||context.enabled!==enabled))error(403,'FORBIDDEN','Contexto de etiquetas fuera del alcance')
 if(context&&!context.products.has(product.id))error(404,'PRODUCT_UNAVAILABLE','Producto no disponible',product.id)
 if(!enabled){if(item.presentation_id!=null||item.unit_revision!==undefined)error(409,'UNITS_DISABLED','Las presentaciones están desactivadas',product.id);return {...product,selectionId:product.id}}
 const p=context?context.products.get(product.id):await tx.product.findFirst({where:{id:product.id,company_id:scope.companyId,deleted:false},select:{id:true,...configFields}})
 if(!p)error(404,'PRODUCT_UNAVAILABLE','Producto no disponible',product.id)
 if(!Units.advancedProduct(p)){if(item.presentation_id!=null)error(409,'UNIT_METADATA_REVIEW_REQUIRED','Configura primero la unidad base',product.id);return {...product,selectionId:product.id}}
 Units.revision(p,item.unit_revision)
 const base=context?context.bases.get(p.base_unit_id):await tx.measureUnit.findFirst({where:{id:p.base_unit_id,company_id:scope.companyId}})
 if(!base)error(409,'UNIT_METADATA_REVIEW_REQUIRED','Revisa la unidad base antes de imprimir',product.id)
 const presentation=item.presentation_id==null?null:context?context.presentations.get(item.presentation_id):await tx.productPresentation.findFirst({where:{id:item.presentation_id,company_id:scope.companyId,product_id:p.id,active:true,sale_enabled:true}})
 if(item.presentation_id!=null&&(!presentation||presentation.product_id!==p.id))error(404,'PRESENTATION_UNAVAILABLE','La presentación no está disponible para venta',product.id)
 const factor=presentation?Units.factorText(presentation.factor):'1',label=presentation?.label??base.label
 const codes=presentation?(context?context.codes.get(selectionKey(p.id,presentation.id))??[]:await tx.productBarcode.findMany({where:{company_id:scope.companyId,product_id:p.id,presentation_id:presentation.id,active:true},orderBy:{code:'asc'}})):[]
 if(codes.length>1)error(409,'BARCODE_REVIEW_REQUIRED','La presentación tiene varios códigos; revisa su configuración',product.id)
 const selected={...product,presentation_id:presentation?.id??null,unit_revision:p.unit_revision,selectionId:selectionKey(p.id,presentation?.id),barcode:presentation?codes[0]?.code??null:product.barcode,name:product.name+' · '+label,unit_label:label,unit_snapshot:{version:2,baseUnit:{id:base.id,code:base.code,name:base.name,label:base.label,decimals:p.quantity_decimals},presentation:presentation?{id:presentation.id,name:presentation.name,label:presentation.label,version:presentation.version,decimals:presentation.quantity_decimals}:null,factor,roundingDelta:'0'}}
 const now=context?.now??new Date()
 selected.price=Units.unitPrice(product,presentation,'LIST',factor,now)
 for(const [tier,key] of [['WHOLESALE','price_wholesale'],['PROMOTION','price_promotion']]){
  const override=presentation?.[key],basePrice=product[key]
  const active=row=>tier!=='PROMOTION'||!row?.promotion_valid_until||new Date(row.promotion_valid_until)>=now
  const source=override!=null&&active(presentation)?presentation:basePrice!=null&&active(product)?product:null
  selected[key]=source?Units.unitPrice(product,source===presentation?presentation:null,tier,factor,now):null
  if(tier==='PROMOTION')selected.promotion_valid_until=source?.promotion_valid_until??null
 }
 return selected
}
module.exports={resolveLabelSelection,selectionKey,loadLabelUnitContext,configFields}
