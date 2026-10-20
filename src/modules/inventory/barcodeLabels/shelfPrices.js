const {isPromotionActive}=require('../../../services/priceResolution')
const labels={LIST:'Normal',WHOLESALE:'Mayoreo',PROMOTION:'Promoción'}
function shelfPricesForProduct(product,tiers,primaryTier='LIST',now=new Date()){
  const prices=[],warnings=[]
  for(const tier of tiers){
    const amount=tier==='LIST'?product.price:tier==='WHOLESALE'?product.price_wholesale:product.price_promotion
    const available=amount!==null&&amount!==undefined&&Number.isFinite(Number(amount))&&(tier==='LIST'?Number(amount)>=0:Number(amount)>0)&&(tier!=='PROMOTION'||isPromotionActive(product,now))
    if(available)prices.push({tier,label:labels[tier],amount:amount.toString()})
    else warnings.push(tier==='PROMOTION'?'Sin promoción vigente; no se imprimirá ese precio.':`Sin precio de ${labels[tier].toLowerCase()}; no se imprimirá esa tarifa.`)
  }
  prices.sort((a,b)=>(a.tier===primaryTier?-1:0)-(b.tier===primaryTier?-1:0))
  return{prices,warnings}
}
const crypto=require('node:crypto')
const Units=require('../units'),{resolveLabelSelection}=require('./unitSelection')
const {parseShelfPreparationInput}=require('./validation')
const {assertAccess,authorizedScope,productWhere,error}=require('./access')
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v
async function prepareShelfLabels(db,scope,raw){
  const input=parseShelfPreparationInput(raw),hash=crypto.createHash('sha256').update(JSON.stringify(canonical(input))).digest('hex')
  return db.$transaction(async tx=>{
    await assertAccess(tx,scope,{write:true})
    const filter=await authorizedScope(tx,scope,input.scope,true)
    const previous=await tx.barcodePrintPreparation.findUnique({where:{company_id_actor_id_request_key:{company_id:scope.companyId,actor_id:scope.userId,request_key:input.requestKey}}})
    if(previous?.snapshot.snapshotVersion===2){if(previous.request_hash!==hash||previous.snapshot.documentType!=='shelf')error(409,'REQUEST_CONFLICT','Esta petición ya se utilizó con otra selección');return previous.snapshot}
    const enabled=await Units.unitsEnabled(tx,scope.companyId)
    if(enabled){await Units.lockCompany(tx,scope.companyId);await Units.assertEnabled(tx,scope);for(const id of [...new Set(input.items.map(i=>i.productId))].sort())await Units.lockProduct(tx,scope,id)}
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`barcode-labels:${scope.companyId}`},0))`
    const rows=await tx.product.findMany({where:{...productWhere(scope,filter),id:{in:input.items.map(i=>i.productId)}},select:{id:true,name:true,kind:true,price:true,price_wholesale:true,price_promotion:true,promotion_valid_until:true,barcode:true,brand:true,size:true}}),byId=new Map(rows.map(p=>[p.id,p])),now=new Date()
    const products=await Promise.all(input.items.map(async item=>{
      const current=byId.get(item.productId);if(!current)error(404,'PRODUCT_UNAVAILABLE','El producto no está disponible en este alcance',item.productId)
      const p=await resolveLabelSelection(tx,scope,current,item,enabled)
      const {prices,warnings}=shelfPricesForProduct(p,item.priceTiers||input.design.priceTiers,input.design.primaryTier,now)
      if(!prices.length)error(400,'PRICE_UNAVAILABLE','No hay ninguna tarifa seleccionada disponible. Revisa el producto o elige otro precio',p.id)
      return{id:p.id,selectionId:p.selectionId,...(p.unit_snapshot?{presentation_id:p.presentation_id,unit_revision:p.unit_revision,unit_label:p.unit_label,unit_snapshot:p.unit_snapshot}:{}),name:p.name,price:p.price.toString(),barcode:p.barcode||'',brand:p.brand,size:p.size,copies:item.copies,shelfPrices:prices,warnings,promotionValidUntil:prices.some(price=>price.tier==='PROMOTION')&&p.promotion_valid_until?new Date(p.promotion_valid_until).toISOString():null}
    }))
    if(previous){
      if(previous.request_hash!==hash||previous.snapshot.documentType!=='shelf')error(409,'REQUEST_CONFLICT','Esta petición ya se utilizó con otra selección')
      for(const p of products){const old=previous.snapshot.products.find(row=>row.id===p.id);if(!old||JSON.stringify(canonical(old))!==JSON.stringify(canonical(p)))error(409,'STALE_PRICES','El catálogo o la vigencia cambió. Actualiza los seleccionados y prepara un documento nuevo',p.id)}
      return previous.snapshot
    }
    const company=await tx.company.findUnique({where:{id:scope.companyId},select:{name:true}}),settings=await tx.systemSetting.findMany({where:{company_id:scope.companyId,key:{in:['currency_code','locale','timezone']}},select:{key:true,value:true}}),setting=Object.fromEntries(settings.map(s=>[s.key,s.value]))
    const id=crypto.randomUUID(),snapshot={id,snapshotVersion:enabled?2:1,documentType:'shelf',companyId:scope.companyId,actorId:scope.userId,companyName:company.name,currencyCode:setting.currency_code||'GTQ',locale:setting.locale||'es-GT',timezone:setting.timezone||'America/Guatemala',createdAt:now.toISOString(),scope:input.scope,products,design:input.design,paper:input.paper,assignedProductIds:[]}
    await tx.barcodePrintPreparation.create({data:{id,company_id:scope.companyId,actor_id:scope.userId,branch_id:filter.branchId,request_key:input.requestKey,request_hash:hash,snapshot}})
    return snapshot
  },{timeout:30000,maxWait:5000})
}
module.exports={shelfPricesForProduct,prepareShelfLabels}
