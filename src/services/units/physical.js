const { parseQuantity } = require('./quantity')
const { Prisma } = require('@prisma/client')
const Decimal = parseQuantity('0', { allowZero: true }).constructor
const decimal = value => new Decimal(value ?? 0)

function physicalQuantity(raw, product, options = {}) {
  require('../catalogItemRules').assertPhysicalItem(product)
  return parseQuantity(raw, { decimals: product.kind === 'KIT' ? 0 : (product.quantity_decimals ?? 0), ...options })
}

// Integer values remain compatible with the pre-migration Prisma Int client.
function storageQuantity(value) {
  const qty = parseQuantity(value, {signed:true,allowZero:true})
  return qty.isInteger() ? qty.toNumber() : qty.toFixed()
}

async function lockPhysicalProducts(tx, productIds, branchId) {
  const ids = [...new Set(productIds.map(String))].sort()
  if (!ids.length) return new Map()
  if (!branchId) throw Object.assign(new Error('Sucursal requerida para inventario físico'),{status:400})
  const cached=require('../checkoutContext').checkoutProducts(tx,ids,{branchId})
  if(cached){for(const product of cached.values())require('../catalogItemRules').assertPhysicalItem(product);return cached}
  await tx.$executeRaw`SELECT id FROM products WHERE id IN (${Prisma.join(ids.map(id=>Prisma.sql`${id}::uuid`))}) AND company_id IN (SELECT company_id FROM branches WHERE id=${String(branchId)}::uuid) ORDER BY id FOR UPDATE`
  const rows = await tx.product.findMany({where:{id:{in:ids},company:{branches:{some:{id:String(branchId)}}}}})
  const products = new Map(rows.map(p=>[String(p.id),p]))
  // Validate the scoped rows read under lock instead of reading them twice.
  for (const id of ids) require('../catalogItemRules').assertPhysicalItem(products.get(id))
  return products
}

async function physicalSnapshot(tx, product) {
  if (!require('../../modules/inventory/units/access').advancedProduct(product)) return null
  const base = await require('../checkoutContext').checkoutUnit(tx,product.company_id,product.base_unit_id,()=>tx.measureUnit.findFirst({where:{id:product.base_unit_id,company_id:product.company_id}}))
  if (!base) throw Object.assign(new Error('Unidad base no encontrada'), {status:409})
  return {version:2,baseUnit:{id:base.id,code:base.code,name:base.name,label:base.label,decimals:product.quantity_decimals},presentation:null,factor:'1',roundingDelta:'0'}
}

// Caller holds the product locks; aggregates share the same bound as each location.
async function assertStockDeltaBounds(tx, products, branchId, entries, sign) {
  const cached=require('../checkoutContext').checkoutBranchRows(tx,entries.map(([id])=>String(id)),branchId)
  const rows=cached?[...cached].map(([product_id,row])=>({product_id,stock:row.stock})):await tx.productStock.findMany({where:{product_id:{in:entries.map(([id])=>String(id))},branch_id:String(branchId)},select:{product_id:true,stock:true}})
  const branches=new Map(rows.map(row=>[String(row.product_id),row.stock]))
  for(const [id,qty]of entries){
    const delta=decimal(qty).mul(sign)
    parseQuantity(decimal(products.get(String(id))?.stock).add(delta),{signed:true,allowZero:true})
    parseQuantity(decimal(branches.get(String(id))).add(delta),{signed:true,allowZero:true})
  }
}

module.exports = { Decimal, decimal, physicalQuantity, storageQuantity, lockPhysicalProducts, physicalSnapshot, assertStockDeltaBounds }
