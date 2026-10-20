const {Prisma}=require('@prisma/client')
const D=value=>new Prisma.Decimal(String(value??0))
function physicalValue(snapshot){
 if(snapshot?.version!==1||!Array.isArray(snapshot.entries)||snapshot.entries.some(e=>e.base_unit_cost==null))return null
 return snapshot.entries.reduce((sum,e)=>sum.add(D(e.base_qty).mul(D(e.base_unit_cost))),D(0))
}
function returnPhysicalValue(item){
 const value=physicalValue(item.physical_snapshot)
 if(value==null)return null
 const qty=D(item.unit_metadata_version===2?item.base_qty:item.qty_returned),restock=D(item.unit_metadata_version===2?item.base_restock_qty??0:item.restock_qty??0)
 return restock.isZero()?D(0):value.mul(restock).div(qty)
}
module.exports={physicalValue,returnPhysicalValue}
