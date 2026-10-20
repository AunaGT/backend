const {Prisma}=require('@prisma/client')
function review(){throw Object.assign(new Error('La unidad histórica del documento necesita revisión'),{status:409,code:'UNIT_METADATA_REVIEW_REQUIRED'})}
function plain(value,places){try{const decimal=new Prisma.Decimal(String(value));if(!decimal.isFinite())review();return places===undefined?decimal.toFixed():decimal.toFixed(places)}catch{review()}}
function publicUnitLine(line,{progress=false}={}){
  if(line.unit_metadata_version==null||line.unit_metadata_version===1)return{}
  const snapshot=line.unit_snapshot,base=snapshot?.baseUnit,presentation=snapshot?.presentation
  if(line.unit_metadata_version!==2||snapshot?.version!==2||!base||!Number.isInteger(base.decimals)||base.decimals<0||base.decimals>6||!(presentation===null||presentation&&Number.isInteger(presentation.decimals)))review()
  const unit={version:2,baseUnit:{id:base.id,code:base.code,name:base.name,label:base.label,decimals:base.decimals},presentation:presentation?{id:presentation.id,version:presentation.version,name:presentation.name,label:presentation.label,decimals:presentation.decimals}:null,factor:plain(snapshot.factor),roundingDelta:plain(snapshot.roundingDelta)}
  return {unit_metadata_version:2,unit_snapshot:unit,unit_label:presentation?.label??base.label,quantity_decimals:presentation?.decimals??base.decimals,qty:plain(line.qty),unit_price:plain(line.unit_price),line_total:plain(line.line_total,2),base_qty:plain(line.base_qty),...(progress?{qty_fulfilled:plain(line.qty_fulfilled??0),base_fulfilled:plain(line.base_fulfilled??0),base_invoiced:plain(line.base_invoiced??0)}:{})}
}
module.exports={publicUnitLine}
