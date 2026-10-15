const crypto=require('node:crypto'),{Prisma}=require('@prisma/client')
const {parsePreparationInput}=require('./validation'),{encodeLabelBarcode}=require('./encoding')
const {assertAccess,authorizedScope,productWhere,error}=require('./access')
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value
async function prepareBarcodeLabels(db,scope,raw){
  const input=parsePreparationInput(raw),hash=crypto.createHash('sha256').update(JSON.stringify(canonical(input))).digest('hex')
  const assigning=input.items.some(i=>i.assignment.mode!=='keep')
  for(let attempt=0;attempt<3;attempt++){
    try{return await db.$transaction(async tx=>{
      await assertAccess(tx,scope,{write:true,assign:assigning})
      const filter=await authorizedScope(tx,scope,input.scope,true)
      // One bounded lock namespace for this company; generic product edits still compete on row locks/unique index.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`barcode-labels:${scope.companyId}`},0))`
      const ids=input.items.map(i=>i.productId).sort()
      await tx.$queryRaw(Prisma.sql`SELECT id FROM products WHERE company_id=${scope.companyId}::uuid AND id IN (${Prisma.join(ids.map(id=>Prisma.sql`${id}::uuid`))}) ORDER BY id FOR UPDATE`)
      const rows=await tx.product.findMany({where:{...productWhere(scope,filter),id:{in:ids}},select:{id:true,name:true,barcode:true,kind:true,price:true,brand:true,size:true}})
      const byId=new Map(rows.map(p=>[p.id,p]))
      for(const id of ids)if(!byId.has(id))error(404,'PRODUCT_UNAVAILABLE','El producto ya no es un bien disponible para venta en este alcance',id)
      const previous=await tx.barcodePrintPreparation.findUnique({where:{company_id_actor_id_request_key:{company_id:scope.companyId,actor_id:scope.userId,request_key:input.requestKey}}})
      if(previous){
        if(previous.request_hash!==hash)error(409,'REQUEST_CONFLICT','Esta petición ya se utilizó con otra selección')
        for(const p of previous.snapshot.products)if(byId.get(p.id)?.barcode!==p.barcode)error(409,'STALE_BARCODE','El código cambió; prepara una impresión nueva',p.id)
        return previous.snapshot
      }
      const products=[],assignedProductIds=[],values=new Map(),bar=input.design.elements.find(e=>e.kind==='barcode')
      for(const item of input.items){
        const p=byId.get(item.productId),current=p.barcode?.trim()?p.barcode:null
        if(current!==item.expectedBarcode)error(409,'STALE_BARCODE','El código del producto cambió; actualiza la selección',p.id)
        const barcode=item.assignment.mode==='keep'?current:item.assignment.mode==='manual'?item.assignment.value:`AUNA${crypto.randomBytes(6).toString('hex').toUpperCase()}`
        if(values.has(barcode))error(409,item.assignment.mode==='auto'||values.get(barcode)==='auto'?'AUTO_BARCODE_COLLISION':'DUPLICATE_BARCODE','Dos productos del lote tienen el mismo código',p.id);values.set(barcode,item.assignment.mode)
        try{encodeLabelBarcode(barcode,input.design.barcodeType,{width:bar.width*input.design.widthMm,height:bar.height*input.design.heightMm})}catch(e){e.productId=p.id;throw e}
        if(item.assignment.mode!=='keep'){
          if(await tx.product.findFirst({where:{company_id:scope.companyId,barcode,id:{not:p.id}}}))error(409,item.assignment.mode==='auto'?'AUTO_BARCODE_COLLISION':'DUPLICATE_BARCODE','El código ya está asignado a otro producto',p.id)
          await tx.product.update({where:{id:p.id},data:{barcode}});assignedProductIds.push(p.id)
        }
        products.push({id:p.id,name:p.name,barcode,price:p.price.toString(),brand:p.brand,size:p.size,copies:item.copies})
      }
      const company=await tx.company.findUnique({where:{id:scope.companyId},select:{name:true}})
      const settings=await tx.systemSetting.findMany({where:{company_id:scope.companyId,key:{in:['currency_code','locale','timezone']}},select:{key:true,value:true}}),setting=Object.fromEntries(settings.map(s=>[s.key,s.value]))
      const id=crypto.randomUUID(),snapshot={id,companyId:scope.companyId,actorId:scope.userId,companyName:company.name,currencyCode:setting.currency_code||'GTQ',locale:setting.locale||'es-GT',timezone:setting.timezone||'America/Guatemala',createdAt:new Date().toISOString(),scope:input.scope,products,design:input.design,paper:input.paper,assignedProductIds}
      await tx.barcodePrintPreparation.create({data:{id,company_id:scope.companyId,actor_id:scope.userId,branch_id:filter.branchId,request_key:input.requestKey,request_hash:hash,snapshot}})
      return snapshot
    },{timeout:30000,maxWait:5000})}catch(e){
      const target=String(e.meta?.target||'')
      if((e.code==='AUTO_BARCODE_COLLISION'||e.code==='P2002'&&target.includes('barcode')&&input.items.some(i=>i.assignment.mode==='auto'))&&attempt<2)continue
      if(e.code==='P2002')error(409,'DUPLICATE_BARCODE','El código o petición ya existe; actualiza los datos')
      throw e
    }
  }
}
module.exports={prepareBarcodeLabels}
