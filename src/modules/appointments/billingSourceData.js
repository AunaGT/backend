const {Prisma}=require('@prisma/client')
const v=require('./domain/validation')
const {commercialQuantity}=require('../../services/catalogItemRules')
const {money}=require('../receivables')
const {normalizeServicePolicy}=require('./domain/servicePolicy')
function bookingLine(booking,product){
  const s=booking.commercial_snapshot
  try{
    if(!s||typeof s.name!=='string'||!s.name.trim()||typeof s.unit!=='string'||!s.unit.trim()||!Number.isInteger(s.quantityDecimals)||s.quantityDecimals<0||s.quantityDecimals>4||! /^[A-Z]{3}$/.test(s.currencyCode))throw Error()
    const qty=commercialQuantity(v.quantity(s.quantity),{kind:'SERVICE',quantity_decimals:s.quantityDecimals})
    const price=money(s.unitPrice),total=money(s.total)
    if(!qty.eq(booking.quantity)||!price.mul(qty).toDecimalPlaces(2,Prisma.Decimal.ROUND_HALF_UP).eq(total))throw Error()
    const policy=normalizeServicePolicy(booking.policy_snapshot)
    return {productId:product.id,itemName:s.name,itemKind:'SERVICE',unitLabel:s.unit,quantityDecimals:s.quantityDecimals,
      quantity:qty.toFixed(4),unitPrice:price.toFixed(2),lineTotal:total.toFixed(2),serviceConditions:require('./index').publicServiceConditions({...policy,allowedVenueKinds:policy.allowedVenueKinds||['BRANCH']}),sortOrder:0}
  }catch{v.fail(409,'INVALID_COMMERCIAL_SNAPSHOT','La reserva no conserva un precio válido. Revisa su alcance antes de cobrar; no se sustituirá por el precio actual')}
}
async function bookingCommercialSource(tx,scope,booking){
  if(booking.company_id!==scope.companyId||booking.branch_id!==scope.branchId)v.fail(404,'NOT_FOUND','Reserva no encontrada')
  const product=await tx.product.findFirst({where:{id:booking.session.product_id,company_id:scope.companyId,kind:'SERVICE'},select:{id:true}})
  const customer=await tx.supplier.findFirst({where:{id:booking.contact_id,company_id:scope.companyId,party_type:'CUSTOMER',deleted:false,estado:1},select:{id:true}})
  if(!product||!customer)return null
  const line=bookingLine(booking,product)
  return {customerId:customer.id,currencyCode:booking.commercial_snapshot.currencyCode,total:line.lineTotal,lines:[line],orders:[]}
}
module.exports={bookingLine,bookingCommercialSource}
