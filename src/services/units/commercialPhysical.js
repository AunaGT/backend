const {D}=require('./commercial')
const {parseQuantity}=require('./quantity')
const fail=(message,code='PHYSICAL_SNAPSHOT_REQUIRED')=>{throw Object.assign(new Error(message),{status:409,code})}

function sliceChunks(chunks,skip,qty,key) {
  let offset=D(skip),left=D(qty)
  const out=[]
  for(const row of chunks){
    const amount=D(row[key])
    if(offset.gte(amount)){offset=offset.sub(amount);continue}
    const take=left.lt(amount.sub(offset))?left:amount.sub(offset)
    if(take.gt(0))out.push({...structuredClone(row),[key]:take.toFixed(),...(row.lots?{lots:sliceChunks(row.lots,offset,take,'qty')}: {})})
    left=left.sub(take);offset=D(0)
    if(left.eq(0))break
  }
  return out
}

function slicePhysicalSnapshot(snapshot,originalBase,qty,consumed=0) {
  if(snapshot?.version!==1||!Array.isArray(snapshot.entries))fail('Falta la asignación física original')
  const original=D(originalBase),prior=D(consumed),end=prior.add(qty)
  if(original.lte(0)||prior.lt(0)||D(qty).lt(0)||end.gt(original))fail('Cantidad fuera del saldo físico original')
  const entries=[]
  const ids=[...new Set(snapshot.entries.map(e=>e.product_id))].sort()
  for(const id of ids){
    const chunks=snapshot.entries.filter(e=>e.product_id===id)
    const total=chunks.reduce((sum,e)=>sum.add(e.base_qty),D(0))
    const precision=chunks[0].unit_snapshot?.version===2?chunks[0].unit_snapshot.baseUnit.decimals:0
    let start,finish
    try{start=parseQuantity(total.mul(prior).div(original),{decimals:precision,allowZero:true});finish=parseQuantity(total.mul(end).div(original),{decimals:precision,allowZero:true})}
    catch{fail('La fracción solicitada no representa una cantidad física exacta del componente','PHYSICAL_SPLIT_NOT_REPRESENTABLE')}
    entries.push(...sliceChunks(chunks,start,finish.sub(start),'base_qty'))
  }
  return {version:1,entries}
}

async function restorePhysicalSnapshot(tx,snapshot,branchId,ctx={}) {
  const {restoreStockMap}=require('../bomStock')
  const {recreateLotsFromSnapshot}=require('../lots')
  const {lockPhysicalProducts}=require('./physical')
  await lockPhysicalProducts(tx,[...new Set(snapshot.entries.map(e=>e.product_id))],branchId)
  const updated=[]
  for(const entry of snapshot.entries){
    const locationId=ctx.locationId||entry.location_id
    const location=await tx.stockLocation.findFirst({where:{id:locationId,active:true,warehouse:{branch_id:branchId,active:true}}})
    if(!location)fail('La ubicación de la asignación física ya no está disponible','PHYSICAL_LOCATION_UNAVAILABLE')
    updated.push(...await restoreStockMap(tx,new Map([[entry.product_id,entry.base_qty]]),branchId,{...ctx,locationId}))
    await recreateLotsFromSnapshot(tx,entry.product_id,branchId,entry.lots||[],entry.base_qty,locationId)
  }
  return updated
}

function allocatePhysicalSnapshots(lineMaps,byProduct) {
  const consumed=new Map()
  return lineMaps.map(map=>({version:1,entries:[...map].flatMap(([id,qty])=>{
    const rows=byProduct.get(id)||[],skip=consumed.get(id)||'0'
    const entries=sliceChunks(rows,skip,qty,'base_qty')
    if(!entries.reduce((sum,e)=>sum.add(e.base_qty),D(0)).eq(qty))fail('La asignación física no cubre la partida')
    consumed.set(id,D(skip).add(qty).toFixed())
    return entries
  })}))
}

async function dispatchCommercialLines(tx,lines,branchId,ctx,{lineMaps=null}={}) {
  const {expandLinesToStockMap,deductStockMap}=require('../bomStock')
  const {consumeLotsFEFO}=require('../lots')
  const {dispatchedByRef}=require('../stockLocations')
  const {lockPhysicalProducts,physicalSnapshot}=require('./physical')
  const maps=lineMaps||await Promise.all(lines.map(line=>expandLinesToStockMap(tx,[line],{companyId:ctx.companyId,allowArchivedServices:ctx.allowArchivedServices})))
  const aggregate=new Map()
  for(const map of maps)for(const [id,qty]of map)aggregate.set(id,D(aggregate.get(id)).add(qty).toFixed())
  const products=await lockPhysicalProducts(tx,[...aggregate.keys()],branchId)
  const updated=await deductStockMap(tx,aggregate,branchId,ctx)
  const locations=await dispatchedByRef(tx,{groupId:ctx.groupId})
  const lots=await consumeLotsFEFO(tx,aggregate,branchId,locations)
  const entries=new Map()
  for(const [id,qty]of aggregate){
    const product=products.get(id),unitSnapshot=await physicalSnapshot(tx,product)||{version:1,factor:'1',unit_label:'unidad'}
    const chunks=locations.get(id)||[]
    let offset=D(0)
    entries.set(id,chunks.map(chunk=>{
      const quantity=D(chunk.qty).toFixed()
      const matching=(lots.get(id)||[]).filter(l=>l.location_id===chunk.location_id)
      const row={product_id:id,location_id:chunk.location_id,base_qty:quantity,base_unit_cost:product.cost==null?null:D(product.cost).toFixed(),unit_snapshot:unitSnapshot,
        lots:sliceChunks(matching,'0',quantity,'qty')}
      offset=offset.add(quantity)
      return row
    }))
    if(!offset.eq(qty))fail('El despacho físico no coincide con las partidas')
  }
  return {updated,snapshots:allocatePhysicalSnapshots(maps,entries)}
}

function snapshotCosts(snapshot,line){
  const value=snapshot.entries.reduce((sum,entry)=>sum.add(D(entry.base_qty).mul(entry.base_unit_cost??0)),D(0))
  const commercial=line.item_kind==='SERVICE'?D(0):value.div(line.qty).toDecimalPlaces(12,4)
  const base=line.item_kind==='SERVICE'?D(0):value.div(line.base_qty??line.qty).toDecimalPlaces(12,4)
  if(commercial.gte('1000000000000')||base.gte('1000000000000'))fail('Costo congelado fuera de rango','COMMERCIAL_COST_OUT_OF_RANGE')
  return{commercial:commercial.toFixed(),base:base.toFixed()}
}

async function persistSalePhysicalSnapshots(tx,saleId,items,snapshots){
  const {isV2}=require('./commercial')
  const saved=await tx.saleItem.findMany({where:{sale_id:saleId},orderBy:{id:'asc'}})
  if(saved.length!==items.length)fail('Las partidas físicas no coinciden con la venta')
  for(let index=0;index<saved.length;index++){
    const cost=snapshotCosts(snapshots[index],items[index])
    await tx.saleItem.update({where:{id:saved[index].id},data:{physical_snapshot:snapshots[index],unit_cost:cost.commercial,
      ...(isV2(items[index])?{base_unit_cost:cost.base}:{})}})
  }
}

async function lockCommercialProducts(tx,lines,{companyId,branchId,allowArchivedServices=false}){
  const {loadProductsWithBom}=require('../bomStock'),{lockPhysicalProducts}=require('./physical')
  const ids=[...new Set(lines.map(line=>line.product_id))]
  let products=await loadProductsWithBom(tx,ids,{companyId,allowArchivedServices})
  const physical=[...products.values()].filter(product=>product.kind!=='SERVICE')
  const lockedIds=[...new Set(physical.flatMap(product=>[product.id,...(product.kind==='KIT'&&!product.stock_assembled?(product.kit_components||[]).map(component=>component.component_product_id):[])]))].sort()
  await lockPhysicalProducts(tx,lockedIds,branchId)
  products=await loadProductsWithBom(tx,ids,{companyId,allowArchivedServices})
  if([...products.values()].some(product=>product.kind==='KIT'&&!product.stock_assembled&&(product.kit_components||[]).some(component=>!lockedIds.includes(component.component_product_id))))fail('La composición cambió; vuelve a intentar','COMMERCIAL_COMPONENTS_CHANGED')
  return products
}

async function reservationStockMaps(tx,documentId,selections,{branchId}={}) {
  const {isV2}=require('./commercial'),{physicalQuantity}=require('./physical')
  if(branchId){
    const physical=selections.filter(selection=>selection.line.item_kind!=='SERVICE')
    const reserved=physical.length?await tx.stockReservation.findMany({where:{document_id:documentId,document_line_id:{in:physical.map(selection=>selection.line_id)},status:'ACTIVE'}}):[]
    await require('./physical').lockPhysicalProducts(tx,[...new Set([...physical.map(selection=>selection.line.product_id),...reserved.map(row=>row.product_id)])].sort(),branchId)
  }
  const maps=[]
  for(const selection of selections){
    const line=selection.line
    if(line.item_kind==='SERVICE'){maps.push(new Map());continue}
    const pending=isV2(line)?D(line.base_qty).sub(line.base_fulfilled||0):D(line.qty).sub(line.qty_fulfilled||0)
    const qty=isV2(line)?selection.base_qty:selection.qty
    const rows=await tx.stockReservation.findMany({where:{document_id:documentId,document_line_id:selection.line_id,status:'ACTIVE'},orderBy:{id:'asc'}})
    if(!rows.length)fail('No hay asignación reservada para la partida')
    const products=await tx.product.findMany({where:{id:{in:rows.map(r=>r.product_id)}}})
    const byId=new Map(products.map(p=>[p.id,p])),map=new Map()
    for(const row of rows){
      let amount
      try{amount=physicalQuantity(D(row.qty).mul(qty).div(pending),byId.get(row.product_id))}
      catch{fail('La entrega no representa una cantidad física exacta del componente','PHYSICAL_SPLIT_NOT_REPRESENTABLE')}
      map.set(row.product_id,D(map.get(row.product_id)).add(amount).toFixed())
    }
    maps.push(map)
  }
  return maps
}

async function saleMovementSnapshot(tx,sale) {
  const message='Este registro antiguo no permite identificar con seguridad los componentes a reintegrar'
  const all=await tx.stockMovement.findMany({where:{ref_type:'sale',ref_id:sale.id,reason:'SALE',qty:{lt:0}},orderBy:[{created_at:'asc'},{id:'asc'}]})
  const lastGroup=all.at(-1)?.group_id
  const rows=lastGroup?all.filter(row=>row.group_id===lastGroup):all
  if(!rows.length)fail(message)
  const products=await tx.product.findMany({where:{id:{in:[...new Set(rows.map(row=>row.product_id))]}}})
  const byId=new Map(products.map(product=>[product.id,product]))
  const entries=rows.map(row=>{
    if(!row.location_id||!byId.has(row.product_id))fail(message)
    const lots=row.unit_snapshot?.lots||[]
    if(byId.get(row.product_id).tracks_expiry&&!lots.reduce((sum,lot)=>sum.add(lot.qty),D(0)).eq(D(row.qty).neg()))fail(message)
    return {product_id:row.product_id,location_id:row.location_id,base_qty:D(row.qty).neg().toFixed(),base_unit_cost:null,
      unit_snapshot:row.unit_snapshot||{version:1,factor:'1',unit_label:'unidad'},lots}
  })
  return {version:1,entries}
}

async function recoverSalePhysicalLine(tx,sale,source) {
  if(source.physical_snapshot)return source.physical_snapshot
  const message='Este registro antiguo no permite identificar con seguridad los componentes a reintegrar'
  const lines=sale.sale_items.filter(line=>line.item_kind!=='SERVICE')
  const {entries}=await saleMovementSnapshot(tx,sale)
  const direct=entries.every(entry=>lines.some(line=>line.product_id===entry.product_id))&&lines.every(line=>entries.some(entry=>entry.product_id===line.product_id))
  if(direct){
    const same=lines.filter(line=>line.product_id===source.product_id).sort((a,b)=>a.id-b.id)
    const chunks=entries.filter(entry=>entry.product_id===source.product_id)
    const total=same.reduce((sum,line)=>sum.add(line.qty),D(0))
    if(!chunks.reduce((sum,entry)=>sum.add(entry.base_qty),D(0)).eq(total))fail(message)
    const prior=same.filter(line=>line.id<source.id).reduce((sum,line)=>sum.add(line.qty),D(0))
    return slicePhysicalSnapshot({version:1,entries:chunks},total,source.qty,prior)
  }
  if(lines.length!==1)fail(message)
  return {version:1,entries}
}

async function cancelSalePhysical(tx,sale,branchId,ctx){
  const {isV2}=require('./commercial'),{lockPhysicalProducts}=require('./physical')
  const lines=sale.sale_items.filter(line=>line.item_kind!=='SERVICE')
  const planned=[]
  if(lines.every(line=>line.physical_snapshot)){
    for(const line of lines){
      const total=isV2(line)?line.base_qty:line.qty
      const consumed=isV2(line)?D(line.base_returned||0):(line.return_items||[]).filter(row=>row.return?.status?.name==='Completada').reduce((sum,row)=>sum.add(row.qty_returned),D(0))
      planned.push(slicePhysicalSnapshot(line.physical_snapshot,total,D(total).sub(consumed),consumed))
    }
  }else{
    const frozen=await saleMovementSnapshot(tx,sale)
    const returned=lines.flatMap(line=>(line.return_items||[]).filter(row=>row.return?.status?.name==='Completada'))
    if(!returned.length)planned.push(frozen)
    else{
      for(const line of lines){
        const snapshot=await recoverSalePhysicalLine(tx,sale,line)
        const consumed=(line.return_items||[]).filter(row=>row.return?.status?.name==='Completada').reduce((sum,row)=>sum.add(row.qty_returned),D(0))
        planned.push(slicePhysicalSnapshot(snapshot,line.qty,D(line.qty).sub(consumed),consumed))
      }
    }
  }
  await lockPhysicalProducts(tx,[...new Set(planned.flatMap(snapshot=>snapshot.entries.map(entry=>entry.product_id)))].sort(),branchId)
  const updated=[]
  for(const snapshot of planned)updated.push(...await restorePhysicalSnapshot(tx,snapshot,branchId,ctx))
  return updated
}

module.exports={slicePhysicalSnapshot,restorePhysicalSnapshot,sliceChunks,allocatePhysicalSnapshots,dispatchCommercialLines,reservationStockMaps,recoverSalePhysicalLine,cancelSalePhysical,snapshotCosts,persistSalePhysicalSnapshots,lockCommercialProducts}
