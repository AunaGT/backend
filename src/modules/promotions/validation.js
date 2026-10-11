const { DateTime } = require('luxon')

function parsePromotionDate(value, isEnd = false) {
  if (value == null || value === '') return null
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const date = DateTime.fromISO(value, { zone: 'America/Guatemala' })
    return date.isValid ? (isEnd ? date.endOf('day') : date.startOf('day')).toJSDate() : undefined
  }
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date
}

function validatePromotionDates(start, end) {
  const startDate = parsePromotionDate(start)
  const endDate = parsePromotionDate(end, true)
  if (startDate === undefined) return 'Fecha de inicio no válida'
  if (endDate === undefined) return 'Fecha de fin no válida'
  if (startDate && endDate && endDate < startDate) return 'La fecha de fin debe ser posterior o igual a la fecha de inicio'
  return null
}

async function validatePromotionCatalog(tx,payload,typeName,companyId) {
  const ids=[...new Set([...(payload.product_ids || []),payload.trigger_product_id,payload.target_product_id].filter(Boolean).map(String))]
  if (ids.length) {
    const products=await tx.product.findMany({where:{id:{in:ids},company_id:companyId,deleted:false},select:{id:true,kind:true}})
    if (products.length!==ids.length) throw Object.assign(new Error('Producto no encontrado en esta empresa'),{status:400})
    if (products.some(product=>product.kind==='SERVICE')) {
      if (!['PERCENTAGE','FIXED_AMOUNT'].includes(typeName)) throw Object.assign(new Error('Esta promoción física no admite servicios'),{status:400})
      await require('../../services/catalogItemRules').assertServicesEnabled(tx,companyId)
    }
  }
  const categories=[...new Set((payload.category_ids || []).map(Number))]
  if (categories.length && await tx.productCategory.count({where:{id:{in:categories},company_id:companyId}})!==categories.length) throw Object.assign(new Error('Categoría no encontrada en esta empresa'),{status:400})
}

async function loadPromotionCart(tx,items,companyId) {
  if (!Array.isArray(items)) throw Object.assign(new Error('Carrito inválido'),{status:400})
  const {validMoney}=require('../../utils/importValidation')
  if(items.some(item=>!item || !['number','string'].includes(typeof item.price) || !/^\d+(?:\.\d{1,2})?$/.test(String(item.price)) || !validMoney(Number(item.price)))) throw Object.assign(new Error('Precio inválido en el carrito'),{status:400})
  const ids=[...new Set(items.map(item=>String(item.product_id || '')))]
  if (!ids.length) return []
  const products=await tx.product.findMany({where:{id:{in:ids},deleted:false,company_id:companyId},select:{id:true,kind:true,quantity_decimals:true,category_id:true}})
  if (products.length!==ids.length) throw Object.assign(new Error('Artículo no encontrado en esta empresa'),{status:400})
  const {commercialQuantity,assertServicesEnabled}=require('../../services/catalogItemRules')
  if (products.some(product=>product.kind==='SERVICE')) await assertServicesEnabled(tx,companyId)
  const byId=new Map(products.map(product=>[product.id,product]))
  return items.map(item=>{const product=byId.get(String(item.product_id));return{...item,kind:product.kind,item_kind:product.kind,category_id:product.category_id,qty:commercialQuantity(item.qty,product).toString()}})
}

module.exports = { validatePromotionDates, parsePromotionDate, validatePromotionCatalog,loadPromotionCart }
