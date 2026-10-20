const {Prisma}=require('@prisma/client')
const {physicalValue,returnPhysicalValue}=require('../../services/units/frozenCost')
const D=value=>new Prisma.Decimal(String(value??0))
const exact=value=>typeof value==='number'?value:D(value).toFixed()
const dimension=row=>row.unit_snapshot?.version===2?row.unit_snapshot.baseUnit?.id??baseUnit(row):row.base_unit_id??row.unit??'legacy-unit'
function baseUnit(row){
 const snapshot=row.unit_snapshot
 if(snapshot?.version===2){if(!snapshot.baseUnit?.label)throw Object.assign(Error('Revisa la unidad histórica antes de preparar el reporte'),{status:409,code:'UNIT_METADATA_REVIEW_REQUIRED'});return snapshot.baseUnit.label}
 if(row.base_unit_id&&!row.base_unit?.label)throw Object.assign(Error('Revisa la unidad base antes de preparar el reporte'),{status:409,code:'UNIT_METADATA_REVIEW_REQUIRED'})
 return row.base_unit?.label??row.unit??'unidades'
}
function quantityTotal(rows,key,unitKey='unit'){
 const units=new Set(rows.map(row=>row.dimension??row[unitKey]??dimension(row)))
 if(units.size>1)return null
 const total=rows.reduce((sum,row)=>sum.add(D(row[key])),D(0))
 return rows.every(row=>typeof row[key]==='number')?total.toNumber():total.toFixed()
}
async function attachBaseUnits(db,companyId,rows,idKey='id'){
 if(!rows.length||!await require('../inventory/units').unitsEnabled(db,companyId))return rows
 const products=await db.product.findMany({where:{company_id:companyId,id:{in:[...new Set(rows.map(r=>r[idKey]))]}},select:{id:true,base_unit_id:true,quantity_decimals:true,base_unit:{select:{id:true,code:true,label:true}}}}),byId=new Map(products.map(p=>[p.id,p]))
 for(const row of rows){const p=byId.get(row[idKey]);if(!p)throw Object.assign(Error('Producto fuera del alcance del reporte'),{status:409});Object.assign(row,{base_unit_id:p.base_unit_id,base_unit:p.base_unit,quantity_decimals:p.quantity_decimals});baseUnit(row)}
 return rows
}
function saleLineCost(line,{restocked=true}={}){
 if((line.item_kind??line.product?.kind)==='SERVICE')return D(0)
 const advanced=line.unit_metadata_version===2
 if(advanced&&(line.base_qty==null||line.base_unit_cost==null))throw Object.assign(Error('Revisa el costo y cantidad base históricos de la venta'),{status:409,code:'UNIT_METADATA_REVIEW_REQUIRED'})
 const qty=D(advanced?line.base_qty:line.qty),cost=D(advanced?line.base_unit_cost:line.unit_cost??line.product?.cost)
 const returned=restocked?(line.return_items??[]).reduce((sum,row)=>sum.add(D(advanced?row.base_restock_qty??0:row.restock_qty)),D(0)):D(0)
 const original=physicalValue(line.physical_snapshot)
 if(original!=null){const restored=restocked?(line.return_items??[]).reduce((sum,row)=>sum.add(returnPhysicalValue(row)??D(advanced?row.base_restock_qty??0:row.restock_qty).mul(cost)),D(0)):D(0);return Prisma.Decimal.max(0,original.sub(restored))}
 return Prisma.Decimal.max(0,qty.sub(returned)).mul(cost)
}
const lineRevenue=line=>D(line.net_total??line.line_total??D(line.qty??line.quantity).mul(D(line.price??line.unit_cost)))
const purchaseAmount=line=>{if(line.line_total!=null)return D(line.line_total);if(line.unit_metadata_version===2){if(line.base_qty==null||line.base_unit_cost==null)throw Object.assign(Error('Revisa el importe y costo base históricos de la compra'),{status:409,code:'UNIT_METADATA_REVIEW_REQUIRED'});return D(line.base_qty).mul(D(line.base_unit_cost))}return D(line.qty??line.quantity).mul(D(line.cost??line.unit_cost))}
module.exports={D,exact,baseUnit,dimension,quantityTotal,attachBaseUnits,saleLineCost,lineRevenue,purchaseAmount}
