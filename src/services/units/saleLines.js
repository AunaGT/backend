const { Prisma } = require('@prisma/client')
const Units = require('../../modules/inventory/units')
const { parseQuantity, lineTotal } = require('./quantity')
const { D, isV2, unitFields } = require('./commercial')
const { lineSnapshot, assertServicesEnabled } = require('../catalogItemRules')

async function resolveCommercialLines(tx, scope, items, { tier = 'LIST', approved = false, allowOverride = false,authorization=null } = {}) {
  if (!Array.isArray(items) || !items.length) throw Object.assign(new Error('Debe incluir al menos un producto'), { status: 400 })
  const ids = [...new Set(items.map(item => String(item.product_id || '')))].sort()
  if (ids.includes('')) throw Object.assign(new Error('Producto requerido'), { status: 400 })
  const products = await tx.product.findMany({where:{id:{in:ids},company_id:scope.companyId,deleted:false},include:{kit_components:true}})
  const byId = new Map(products.map(product=>[String(product.id),product]))
  const enabled = products.some(p=>p.base_unit_id) || await Units.unitsEnabled(tx,scope.companyId)
  if (enabled) {
    const locks=[...new Set([...ids,...products.flatMap(p=>p.kind==='KIT'&&!p.stock_assembled?(p.kit_components||[]).map(c=>c.component_product_id):[])])].sort()
    await tx.$executeRaw`SELECT id FROM products WHERE company_id=${scope.companyId}::uuid AND id IN (${Prisma.join(locks.map(id=>Prisma.sql`${id}::uuid`))}) ORDER BY id FOR UPDATE`
    const locked=await tx.product.findMany({where:{id:{in:ids},company_id:scope.companyId,deleted:false},include:{kit_components:true}})
    for(const product of locked){
      if((product.kit_components||[]).some(component=>!locks.includes(component.component_product_id)))throw Object.assign(new Error('La composición cambió; vuelve a intentar'),{status:409})
      byId.set(String(product.id),product)
    }
  }
  if (products.some(p=>p.kind==='SERVICE')) await assertServicesEnabled(tx,scope.companyId)
  const lines=[]
  for (const raw of items) {
    const product=byId.get(String(raw.product_id))
    if (!product || product.available_for_sale===false) throw Object.assign(new Error('Producto no disponible para venta'),{status:400})
    if (!approved && ['factor','base_qty','base_unit_cost','unit_snapshot','unit_metadata_version','physical_snapshot','frozen_unit_price','authorization','authorization_context'].some(k=>Object.hasOwn(raw,k))) {
      throw Object.assign(new Error('El servidor determina la conversión y el snapshot'),{status:400})
    }
    const resolved=await Units.resolveUnitLine(tx,scope,product,{qty:raw.qty,unit_revision:raw.unit_revision,
      ...(Object.hasOwn(raw,'presentation_id')?{presentation_id:raw.presentation_id}:{}),accept_rounding:approved?true:raw.accept_rounding,price_tier:tier},
    {authorization,snapshot:approved&&isV2(raw)?raw.unit_snapshot:null,...(approved&&isV2(raw)?{frozen_unit_price:raw.unit_price??raw.price}:{})})
    const v2=isV2(resolved)
    const qty=resolved.qty,baseQty=approved&&v2?String(raw.base_qty):resolved.base_qty
    let price=approved?String(raw.unit_price??raw.price):resolved.unit_price
    if (!approved&&allowOverride&&(raw.unit_price!=null||raw.price!=null))price=parseQuantity(String(raw.unit_price??raw.price),{decimals:v2?6:2,allowZero:true,max:'9999999999.99'}).toFixed()
    const baseCost=product.kind==='SERVICE'?'0':product.cost==null?null:D(product.cost).toFixed()
    const commercialCost=baseCost==null?null:D(baseCost).mul(baseQty).div(qty).toDecimalPlaces(12,Prisma.Decimal.ROUND_HALF_UP).toFixed()
    lines.push({product_id:product.id,qty,unit_price:price,line_total:approved&&raw.line_total!=null?String(raw.line_total):lineTotal(qty,price),
      unit_cost:approved&&raw.unit_cost!=null?raw.unit_cost:commercialCost,...lineSnapshot(approved?raw:resolved),
      ...(v2?{...unitFields({...resolved,base_qty:baseQty}),unit_label:resolved.unit_label,quantity_decimals:resolved.quantity_decimals,
        base_unit_cost:approved&&raw.base_unit_cost!=null?raw.base_unit_cost:baseCost}: {})})
  }
  return lines
}

module.exports = { resolveCommercialLines }
