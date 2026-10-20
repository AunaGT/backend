const {prisma,prismaTransaction}=require('../../../models/prisma')
const units=require('./index')
const {requestUnitScope}=units
function handler(fn){return async(req,res,next)=>{try{await fn(req,res,requestUnitScope(req))}catch(e){if(e.status)return res.status(e.status).json({message:e.message,...(e.code?{code:e.code}:{}),...(e.details?{details:e.details}:{})});next(e)}}}
const transaction=fn=>prismaTransaction.$transaction(fn,{maxWait:15000,timeout:30000})
exports.list=handler(async(req,res,scope)=>res.json({items:await units.listUnits(prisma,scope,{includeArchived:req.query.include_archived==='true'})}))
exports.save=handler(async(req,res,scope)=>{const row=await transaction(tx=>units.saveUnit(tx,scope,req.body,req.params.unitId));res.status(req.params.unitId?200:201).json({...row,factor:units.factorText(row.factor)})})
exports.presentations=handler(async(req,res,scope)=>{const items=await units.listPresentations(prisma,scope,req.params.id,{includeArchived:req.query.include_archived==='true'});const product=await units.scopedProduct(prisma,scope,req.params.id);res.json({items,unit_revision:product.unit_revision,base_unit_locked:await units.productBaseLocked(prisma,scope,product)})})
exports.savePresentation=handler(async(req,res,scope)=>res.status(req.params.presentationId?200:201).json(await transaction(async tx=>{
  const row=await units.savePresentation(tx,scope,req.params.id,req.body,req.params.presentationId)
  const [product,codes]=await Promise.all([units.scopedProduct(tx,scope,req.params.id),tx.productBarcode.findMany({where:{company_id:scope.companyId,product_id:req.params.id,active:true}})])
  return {presentation:units.presentationDTO(row,codes),unit_revision:product.unit_revision}
})))
exports.archivePresentation=handler(async(req,res,scope)=>res.json(await transaction(async tx=>{
  units.objectInput(req.body,['unit_revision'])
  const row=await units.savePresentation(tx,scope,req.params.id,{unit_revision:req.body.unit_revision,active:false},req.params.presentationId)
  return {presentation:units.presentationDTO(row),unit_revision:(await units.scopedProduct(tx,scope,req.params.id)).unit_revision}
})))
exports.configure=handler(async(req,res,scope)=>res.json(await transaction(async tx=>{
  const product=await units.configureProduct(tx,scope,req.params.id,req.body)
  return (await units.extendProductDTO(tx,scope,[product]))[0]
})))
exports.barcode=handler(async(req,res,scope)=>{
  const operation=req.query.operation||'SALE';if(!['SALE','PURCHASE'].includes(operation))units.fail(400,'Operación inválida')
  res.json(await units.resolveBarcode(prisma,scope,req.query.code,{operation}))
})
exports.preview=handler(async(req,res,scope)=>{
  units.objectInput(req.body,['qty','presentation_id','unit_revision','accept_rounding','price_tier','operation'])
  await units.assertEnabled(prisma,scope)
  res.json(await transaction(async tx=>{const product=await units.scopedProduct(tx,scope,req.params.id);return units.resolveUnitLine(tx,scope,product,req.body,{operation:req.body.operation||'SALE'})}))
})
