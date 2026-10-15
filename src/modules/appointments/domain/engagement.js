const { Prisma }=require('@prisma/client')
const {fail}=require('./validation')
function quantity(raw,decimals) {
  const value=raw instanceof Prisma.Decimal ? raw.toString() : raw
  if(typeof value!=='string'||!/^\d{1,8}(?:\.\d{1,4})?$/.test(value)) fail(400,'INVALID_QUANTITY','Indica una cantidad comercial válida')
  const qty=new Prisma.Decimal(value)
  if(!Number.isInteger(decimals)||decimals<0||decimals>4||qty.lte(0)||qty.decimalPlaces()>decimals) fail(400,'INVALID_QUANTITY','La cantidad no respeta la unidad del servicio')
  return qty
}
function assertLineCoverage(line,allocations) {
  if(!line||line.itemKind!=='SERVICE') fail(400,'NOT_SERVICE','Solo se pueden programar partidas de servicio')
  const total=quantity(line.quantity,line.quantityDecimals)
  let covered=new Prisma.Decimal(0)
  for(const allocation of allocations) {
    if(!['COMMITTED','COMPLETED','SOLD','CANCELLED','RELEASED'].includes(allocation.state)) fail(400,'INVALID_COVERAGE_STATE','Estado de programación inválido')
    const qty=quantity(allocation.quantity,line.quantityDecimals)
    if(allocation.state!=='RELEASED') covered=covered.add(qty)
  }
  if(covered.gt(total)) fail(409,'OVERBOOKED_QUANTITY','La cantidad ya programada o realizada supera lo contratado')
  return total.sub(covered).toFixed(line.quantityDecimals)
}
module.exports={assertLineCoverage,quantity}
