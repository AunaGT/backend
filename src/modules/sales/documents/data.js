const {Prisma}=require('@prisma/client')
const incomplete=()=>{throw Object.assign(new Error('Faltan datos históricos de esta venta para preparar el documento. La venta sigue registrada.'),{status:409,code:'DOCUMENT_DATA_INCOMPLETE'})}
function decimal(value,money=false) {
  if(value===null||value===undefined)incomplete()
  try {const d=new Prisma.Decimal(String(value));if(!d.isFinite()||money&&d.decimalPlaces()>2)incomplete();return money?d.toFixed(2):d.toFixed()}catch{incomplete()}
}
function unitPrice(value){const exact=decimal(value),d=new Prisma.Decimal(exact);return d.toFixed(Math.max(2,d.decimalPlaces()))}
function documentData(sale,settings={}) {
  if(!sale.sale_items?.length)incomplete()
  const lines=sale.sale_items.map(item=>{
    const snapshot=item.unit_snapshot
    const unit=item.unit_metadata_version===2?snapshot?.version===2&&(snapshot.presentation?.label||snapshot.baseUnit?.label):item.unit_label
    if(!item.item_name||!unit)incomplete()
    return {name:item.item_name,quantity:decimal(item.qty),unit,price:unitPrice(item.price),total:decimal(item.net_total,true)}
  })
  return {schemaVersion:1,purpose:'INTERNAL_RECEIPT',issuedAt:new Date(sale.date).toISOString(),saleReference:sale.reference||sale.id,
    emitter:{name:settings.company_name||sale.branch.company?.name||'',nit:settings.company_nit||sale.branch.company?.tax_id||'',address:settings.company_address||sale.branch.company?.address||'',branch:sale.branch.name},
    receiver:{name:sale.customer||'Consumidor final',nit:sale.customer_nit||'CF'},lines,
    // The POS stores null when no discount was applied; it is not missing financial data.
    totals:{subtotal:decimal(sale.subtotal,true),discount:decimal(sale.discount_total??'0',true),total:decimal(sale.total,true),currency:settings.currency_code&&settings.currency_code!=='GTQ'?settings.currency_code:'Q'},
    paymentAtPreparation:{method:sale.payment_method?.name||'',...(sale.amount_received!=null?{received:decimal(sale.amount_received,true)}:{}),...(sale.change!=null?{change:decimal(sale.change,true)}:{})},notices:['Comprobante interno. No constituye factura fiscal.'],fiscal:null}
}
module.exports={documentData}
