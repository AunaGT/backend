const {Prisma}=require('@prisma/client')

// Capabilities belong to this exact transaction, never to request JSON or a global cache.
const contexts=new WeakMap()
const fail=(message,code)=>{throw Object.assign(new Error(message),{status:409,code})}
const idsOf=ids=>[...new Set(ids.map(String))].sort()
function contextFor(tx,{companyId,branchId}={}){
 const ctx=contexts.get(tx)
 return ctx&&(companyId===undefined||ctx.scope.companyId===companyId)&&(branchId===undefined||ctx.scope.branchId===String(branchId))?ctx:null
}
function checkoutProducts(tx,ids,scope){
 const ctx=contextFor(tx,scope)
 return ctx&&ids.every(id=>ctx.products.has(String(id)))?new Map(ids.map(id=>[String(id),ctx.products.get(String(id))])):null
}
async function withCheckoutContext(tx,scope,items,run){
 if(!scope.companyId||!scope.branchId)throw Object.assign(new Error('Empresa y sucursal requeridas'),{status:400})
 if(contexts.has(tx))fail('El cobro ya tiene un contexto activo','CHECKOUT_CONTEXT_ACTIVE')
 const roots=idsOf(items.map(item=>item.product_id||''))
 if(roots.includes(''))throw Object.assign(new Error('Producto requerido'),{status:400})
 const include={kit_components:{orderBy:{sort_order:'asc'},include:{component_product:true}}}
 const ownership={company_id:scope.companyId,company:{branches:{some:{id:scope.branchId}}}}
 const discovery=await tx.product.findMany({where:{id:{in:roots},...ownership},include})
 const physicalComponents=rows=>rows.filter(p=>p.kind==='KIT'&&!p.stock_assembled).flatMap(p=>(p.kit_components||[]).map(c=>c.component_product_id))
 const locked=idsOf([...roots,...physicalComponents(discovery)])
 await tx.$executeRaw`SELECT id FROM products WHERE company_id=${scope.companyId}::uuid AND company_id IN (SELECT company_id FROM branches WHERE id=${scope.branchId}::uuid) AND id IN (${Prisma.join(locked.map(id=>Prisma.sql`${id}::uuid`))}) ORDER BY id FOR UPDATE`
 const rows=await tx.product.findMany({where:{id:{in:locked},...ownership},include})
 const products=new Map(rows.map(row=>[String(row.id),{...row,kit_components:row.kit_components||[]}]))
 if(roots.some(id=>!products.has(id)||products.get(id).deleted))throw Object.assign(new Error('Producto no encontrado en la empresa y sucursal'),{status:404})
 if(physicalComponents(rows.filter(row=>roots.includes(row.id))).some(id=>!locked.includes(id)))fail('La composición cambió; vuelve a intentar','COMMERCIAL_COMPONENTS_CHANGED')
 for(const row of products.values())for(const component of row.kind==='KIT'&&!row.stock_assembled?row.kit_components:[]){
  if(!products.has(component.component_product_id))throw Object.assign(new Error('Componente no encontrado en la empresa'),{status:404})
  component.component_product={...products.get(component.component_product_id),kit_components:[]}
 }
 const baseIds=idsOf(rows.map(p=>p.base_unit_id).filter(Boolean))
 const presentationIds=idsOf([...items.map(line=>line.presentation_id),...rows.map(p=>p.default_sale_presentation_id)].filter(Boolean))
 const units=baseIds.length?await tx.measureUnit.findMany({where:{company_id:scope.companyId,id:{in:baseIds}}}):[]
 const presentations=presentationIds.length?await tx.productPresentation.findMany({where:{company_id:scope.companyId,id:{in:presentationIds},active:true}}):[]
 const ctx={scope:{companyId:scope.companyId,branchId:String(scope.branchId)},products,units:new Map(units.map(row=>[row.id,row])),presentations:new Map(presentations.map(row=>[row.id,row])),settings:new Map(),branchRows:new Map(),ensured:new Set()}
 contexts.set(tx,ctx)
 try{return await run()}finally{contexts.delete(tx)}
}
function checkoutSetting(tx,companyId,key,read){
 const ctx=contextFor(tx,{companyId})
 if(!ctx)return read()
 if(!ctx.settings.has(key))ctx.settings.set(key,Promise.resolve().then(read))
 return ctx.settings.get(key)
}
function checkoutUnit(tx,companyId,id,read){
 const ctx=contextFor(tx,{companyId})
 return ctx?Promise.resolve(ctx.units.get(id)||null):read()
}
function checkoutPresentation(tx,companyId,productId,id,read){
 const ctx=contextFor(tx,{companyId}),row=ctx?.presentations.get(id)
 return ctx?Promise.resolve(row?.product_id===productId&&row.active?row:null):read()
}
function checkoutBranchRows(tx,ids,branchId,rows){
 const ctx=contextFor(tx,{branchId})
 if(!ctx)return null
 if(rows)for(const row of rows)ctx.branchRows.set(String(row.id),row)
 return ids.every(id=>ctx.branchRows.has(String(id)))?new Map(ids.map(id=>[String(id),ctx.branchRows.get(String(id))])):null
}
function checkoutEnsuredRows(tx,ids,branchId,mark=false){
 const ctx=contextFor(tx,{branchId})
 if(!ctx)return false
 if(mark)ids.forEach(id=>ctx.ensured.add(String(id)))
 return ids.every(id=>ctx.ensured.has(String(id)))
}
function checkoutStockDelta(tx,entries,branchId){
 const ctx=contextFor(tx,{branchId})
 if(!ctx)return
 for(const [id,qty]of entries){
  const product=ctx.products.get(String(id)),branch=ctx.branchRows.get(String(id))
  if(product)product.stock=new Prisma.Decimal(product.stock??0).add(qty)
  if(branch)branch.stock=new Prisma.Decimal(branch.stock??0).add(qty)
 }
}
module.exports={withCheckoutContext,checkoutProducts,checkoutSetting,checkoutUnit,checkoutPresentation,checkoutBranchRows,checkoutEnsuredRows,checkoutStockDelta}
