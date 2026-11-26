const {Prisma}=require('@prisma/client')
const Packages=require('../../services/commercialPackages')
const {parsePackageSelections}=require('../inventory/packages/selection')
const {loadPackageVersion,assertPackageReadAccess}=require('../inventory/packages/catalog')
const {uuid,parsePackageDefinition}=require('../inventory/packages/definition')
const {objectInput}=require('../inventory/units/access')
const {resolveCommercialLines}=require('../../services/units/saleLines')
const {allocateNetLineTotals}=require('../../services/saleLineTotals')
const fail=(code,message,status=409)=>{throw Object.assign(new Error(message),{code,status})}
const D=v=>new Prisma.Decimal(String(v??0))
function salePackageScope(scope){
 if(!scope.isAdmin&&!scope.permissions?.includes('sales.create'))fail('FORBIDDEN','No tienes permiso para seleccionar paquetes en ventas',403)
 uuid(scope.companyId,'Empresa');uuid(scope.branchId,'Sucursal')
 if(scope.isConsolidated||scope.branchId==='all')fail('BRANCH_REQUIRED','Selecciona una sucursal',400)
 return {...scope,actorId:scope.userId||scope.actorId,branchIds:[scope.branchId]}
}
const referenceIds=d=>d.variants.flatMap(v=>[...v.components,...v.choices.flatMap(c=>c.options)].map(c=>c.productId)).filter(Boolean)
async function resolveSalePackages(tx,rawScope,raw,{existingGroups=null,freeProductIds=[],allowIncomplete=false}={}){
 const scope=salePackageScope(rawScope),selections=parsePackageSelections(raw??[])
 if(!selections.length)return {groups:[],lines:[],subtotal:'0.00',issues:[]}
 const ids=new Set(freeProductIds.map(id=>uuid(id,'Producto')))
 for(const s of selections){
  const record=await loadPackageVersion(tx,scope,s.packageId,s.version,{forNewSelection:false,readPermission:'sales.create'})
  referenceIds(record.definition).forEach(id=>ids.add(id))
 }
 const roots=[...ids].sort(),discovered=await tx.product.findMany({where:{company_id:scope.companyId,id:{in:roots}},include:{kit_components:true}})
 const children=rows=>rows.filter(p=>p.kind==='KIT'&&!p.stock_assembled).flatMap(p=>(p.kit_components||[]).map(c=>c.component_product_id))
 const locked=[...new Set([...roots,...children(discovered)])].sort()
 if(locked.length)await tx.$executeRaw`SELECT id FROM products WHERE company_id=${scope.companyId}::uuid AND id IN (${Prisma.join(locked.map(id=>Prisma.sql`${id}::uuid`))}) ORDER BY id FOR UPDATE`
 const current=await tx.product.findMany({where:{company_id:scope.companyId,id:{in:roots}},include:{kit_components:true}})
 if(children(current).some(id=>!locked.includes(id)))fail('PACKAGE_REVIEW_REQUIRED','La composición cambió. Vuelve a revisar el paquete.',409)
 const result=await Packages.buildPackageGroups(tx,scope,selections,{existingGroups,readPermission:'sales.create',allowIncomplete})
 await Packages.assertPackageCurrency(tx,scope.companyId,result.groups)
 return {...result,lines:result.lines.length?await resolveCommercialLines(tx,scope,result.lines,{approved:true}):[]}
}
function salePackageNetLines(items,total){
 const fixed=items.filter(l=>l.package_component_key).reduce((s,l)=>s.add(l.line_total),D(0))
 const available=D(total).sub(fixed),free=items.filter(l=>!l.package_component_key)
 const gross=free.reduce((s,l)=>s.add(D(l.price??l.unit_price).mul(l.qty).toDecimalPlaces(2,Prisma.Decimal.ROUND_HALF_UP)),D(0))
 if(available.lt(0)||available.gt(gross))fail('PACKAGE_PRICE_PROTECTED','Las promociones deben aplicarse a los artículos sueltos; el paquete conserva su precio acordado',400)
 const totals=allocateNetLineTotals(free.map(l=>({price:l.price??l.unit_price,qty:l.qty})),available.toFixed(2));let index=0
 return items.map(l=>l.package_component_key?D(l.line_total).toFixed(2):D(totals[index++]).toFixed(2))
}
function publishedSummary(row,branchId){
 const d=parsePackageDefinition(row.definition,{complete:true}),prices=d.variants.map(v=>D(v.price)).sort((a,b)=>a.comparedTo(b))
 return{id:row.id,name:d.name,version:row.active_version,activeVersion:row.active_version,archivedAt:null,branchIds:[branchId],imageUrl:d.imageUrl,currency:d.currency,description:d.description,
  variantCount:d.variants.length,priceFrom:prices[0]?.toFixed(2)??null,priceTo:prices.at(-1)?.toFixed(2)??null}
}
async function publishedRows(db,scope,{q='',cursor=null,limit=25,id=null}={}){
 await assertPackageReadAccess(db,scope,'sales.create')
 return db.$queryRaw`SELECT p.id,p.active_version,v.definition FROM commercial_packages p JOIN commercial_package_versions v ON v.company_id=p.company_id AND v.package_id=p.id AND v.version=p.active_version
  WHERE p.company_id=${scope.companyId}::uuid AND p.archived_at IS NULL AND ${scope.branchId}::uuid=ANY(v.branch_ids)
   AND EXISTS(SELECT 1 FROM commercial_package_branches b WHERE b.package_id=p.id AND b.branch_id=${scope.branchId}::uuid)
   AND (${id}::uuid IS NULL OR p.id=${id}::uuid) AND (${cursor}::uuid IS NULL OR p.id>${cursor}::uuid)
   AND position(lower(${q}) IN lower(v.definition->>'name'))>0 ORDER BY p.id LIMIT ${limit}`
}
async function listSalePackages(db,rawScope,query={}){
 const scope=salePackageScope(rawScope)
 objectInput(query,['q','cursor','limit','activeOnly'])
 const q=String(query.q??'').trim(),limit=query.limit===undefined?25:Number(query.limit),cursor=query.cursor==null?null:uuid(query.cursor,'Cursor')
 if(q.length>100||!Number.isSafeInteger(limit)||limit<1||limit>100)fail('INVALID_PACKAGE','Revisa la búsqueda o cantidad de paquetes',400)
 const rows=await publishedRows(db,scope,{q,cursor,limit:limit+1}),page=rows.slice(0,limit)
 return{items:page.map(row=>publishedSummary(row,scope.branchId)),nextCursor:rows.length>limit?page.at(-1).id:null}
}
async function getSalePackage(db,rawScope,id){
 const scope=salePackageScope(rawScope),[row]=await publishedRows(db,scope,{id:uuid(id,'Paquete'),limit:1})
 if(!row)fail('NOT_FOUND','Paquete activo no encontrado en esta sucursal',404)
 const definition=parsePackageDefinition(row.definition,{complete:true}),ids=[...new Set(referenceIds(definition))]
 const products=ids.length?await db.product.findMany({where:{company_id:scope.companyId,id:{in:ids}},select:{id:true,name:true,service_unit_label:true,base_unit:{select:{label:true}},presentations:{select:{id:true,label:true}}}}):[]
 return{...publishedSummary(row,scope.branchId),definition,activeDefinition:definition,references:products.map(p=>({id:p.id,name:p.name,unitLabel:p.service_unit_label||p.base_unit?.label||'unidad',presentations:(p.presentations||[]).map(v=>({id:v.id,label:v.label}))}))}
}
module.exports={resolveSalePackages,salePackageNetLines,salePackageScope,listSalePackages,getSalePackage}
