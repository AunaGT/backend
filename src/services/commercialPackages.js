const {D,cumulativeAmount}=require('./units/commercial')
const {parsePackageSelections,validatePackageSelection}=require('../modules/inventory/packages/selection')
const {allocatePackagePrice}=require('../modules/inventory/packages/pricing')
const {loadPackageVersion}=require('../modules/inventory/packages/catalog')
const {validateReferences}=require('../modules/inventory/packages/references')
const {calculateUnitLine}=require('../modules/inventory/units/calculation')
const {bounded,uuid,integer,text,decimal}=require('../modules/inventory/packages/definition')
const {publicConditionsFromRow,publicProfileSelect}=require('../modules/appointments')
const fail=(code,message,status=409)=>{throw Object.assign(new Error(message),{status,code})}
const review=()=>fail('PACKAGE_REVIEW_REQUIRED','La composición del paquete cambió. Revisa sus productos, cantidades y precios antes de continuar')
const money=value=>D(value).toFixed(2)
const canonicalSelection=selection=>({...selection,choices:selection.choices.map(choice=>({...choice,items:[...choice.items].sort((a,b)=>a.optionId.localeCompare(b.optionId))})).sort((a,b)=>a.choiceId.localeCompare(b.choiceId))})
const sameSelection=(a,b)=>JSON.stringify(canonicalSelection(a))===JSON.stringify(canonicalSelection(b))
function assertFreePackageItems(items){
  if(!Array.isArray(items))return
  for(const item of items)if(item&&Object.keys(item).some(key=>key.startsWith('package')))fail('INVALID_PACKAGE','Los componentes de un paquete se calculan en el servidor; agrégalo desde Paquetes',400)
}
function packageLineFields(line){return line.package_component_key?{package_component_key:line.package_component_key}:{}}
function componentFromLine(line,leaf){
  return{key:leaf.key,productId:line.product_id,itemName:line.item_name,itemKind:line.item_kind,quantity:String(line.qty),
    baseQty:String(line.base_qty??line.qty),presentationId:leaf.presentationId,unitRevision:leaf.unitRevision,
    unitMetadataVersion:line.unit_metadata_version,unitSnapshot:structuredClone(line.unit_snapshot),unitLabel:line.unit_label,
    quantityDecimals:line.quantity_decimals,unitPrice:String(line.unit_price),lineTotal:money(line.line_total),netLineTotal:money(line.line_total),
    serviceConditions:line.service_schedule_snapshot??null}
}
function lineFromComponent(c){
  return{product_id:c.productId,qty:c.quantity,unit_price:c.unitPrice,line_total:c.lineTotal,
    item_name:c.itemName,item_kind:c.itemKind,unit_label:c.unitLabel,quantity_decimals:c.quantityDecimals,
    unit_metadata_version:c.unitMetadataVersion,unit_snapshot:structuredClone(c.unitSnapshot),base_qty:c.baseQty,
    ...(c.unitMetadataVersion===2?{base_fulfilled:'0',base_invoiced:'0'}:{}),
    service_schedule_snapshot:c.serviceConditions,package_component_key:c.key}
}
function readGroups(raw){
  if(raw==null)return[]
  try{
    if(!Array.isArray(raw)||raw.length>100)review()
    bounded(raw,'packageGroups')
    const seen=new Set(),keys=new Set()
    for(const group of raw){
      if(group.schemaVersion!==1||!['COMPLETE','INCOMPLETE'].includes(group.state))review()
      uuid(group.groupId,'groupId');uuid(group.packageId,'packageId');uuid(group.variantId,'variantId');integer(group.version,'version',1,2147483647)
      if(seen.has(group.groupId))review();seen.add(group.groupId)
      const selection=parsePackageSelections([group.selection])[0]
      if(selection.groupId!==group.groupId||selection.packageId!==group.packageId||selection.variantId!==group.variantId||selection.version!==group.version)review()
      text(group.name,'name',150);text(group.variantName,'variantName',150)
      if(!/^[A-Z]{3}$/.test(group.currency)||!Array.isArray(group.components)||group.components.length>100||!Array.isArray(group.issues))review()
      decimal(group.estimatedAmount,'estimatedAmount',{allowZero:true,decimals:2,max:'9999999999.99'})
      if(group.state==='INCOMPLETE'){
        if(group.amount!==null||group.netAmount!==null||group.components.length||!group.issues.length)review()
      }else{
        decimal(group.amount,'amount',{allowZero:true,decimals:2,max:'9999999999.99'});decimal(group.netAmount,'netAmount',{allowZero:true,decimals:2,max:'9999999999.99'})
        if(!group.components.length||group.issues.length)review()
      }
      for(const c of group.components){
        if(typeof c.key!=='string'||c.key.slice(0,37)!==group.groupId+':')review()
        uuid(c.key.slice(37),'componentId');uuid(c.productId,'productId')
        if(keys.has(c.key))review();keys.add(c.key)
        if(!['STANDARD','KIT','SERVICE'].includes(c.itemKind)||![1,2].includes(c.unitMetadataVersion))review()
        decimal(c.quantity,'quantity');decimal(c.baseQty,'baseQty')
        decimal(c.lineTotal,'lineTotal',{allowZero:true,decimals:2,max:'9999999999.99'});decimal(c.netLineTotal,'netLineTotal',{allowZero:true,decimals:2,max:'9999999999.99'})
        if(!D(c.unitPrice).isFinite()||D(c.unitPrice).lt(0)||D(c.unitPrice).gt('9999999999.99')||D(c.unitPrice).decimalPlaces()>18)review()
        if(!c.unitSnapshot||c.unitSnapshot.version!==c.unitMetadataVersion)review()
      }
    }
    if(keys.size>100)review()
    return raw
  }catch{review()}
}
async function buildPackageGroups(tx,scope,raw,{existingGroups=null,allowIncomplete=false}={}){
  const selections=parsePackageSelections(raw),previous=readGroups(existingGroups),groups=[],lines=[],issues=[]
  for(const selection of selections){
    const old=previous.find(group=>group.groupId===selection.groupId)
    const unchanged=old&&sameSelection(old.selection,selection)
    const record=await loadPackageVersion(tx,scope,selection.packageId,selection.version,{forNewSelection:!unchanged})
    if(unchanged){
      // Recheck availability and units, but preserve the accepted names and amounts.
      await validateReferences(tx,scope,record.definition,{lock:true})
      const group=structuredClone(old);groups.push(group);lines.push(...group.components.map(lineFromComponent));issues.push(...group.issues)
      continue
    }
    const variant=record.definition.variants.find(variant=>variant.id===selection.variantId)
    const resolved=validatePackageSelection(record.definition,selection)
    const group={schemaVersion:1,groupId:selection.groupId,packageId:selection.packageId,version:selection.version,variantId:selection.variantId,
      name:record.definition.name,variantName:variant.name,currency:record.definition.currency,state:resolved.state,
      estimatedAmount:variant.price,amount:resolved.state==='COMPLETE'?variant.price:null,netAmount:resolved.state==='COMPLETE'?variant.price:null,
      selection,components:[],issues:resolved.issues}
    if(resolved.state==='COMPLETE'){
      const prices=new Map(allocatePackagePrice({amount:variant.price,leaves:resolved.leaves}).map(price=>[price.key,price]))
      const serviceIds=resolved.leaves.filter(leaf=>record.products.get(leaf.productId).kind==='SERVICE').map(leaf=>leaf.productId)
      const profiles=serviceIds.length?await tx.product.findMany({where:{company_id:scope.companyId,id:{in:serviceIds}},select:{id:true,service_schedule_profile:{select:publicProfileSelect}}}):[]
      for(const leaf of resolved.leaves){
        const product=record.products.get(leaf.productId),price=prices.get(leaf.key)
        const line={product_id:product.id,...calculateUnitLine(product,{baseUnit:product.base_unit,presentation:leaf.presentationId?product.presentations.find(p=>p.id===leaf.presentationId):null,operation:'PURCHASE'},
          {qty:leaf.quantity,presentation_id:leaf.presentationId,unit_revision:leaf.unitRevision,accept_rounding:false}),
          unit_price:price.unitPrice,line_total:price.lineTotal,package_component_key:leaf.key,
          service_schedule_snapshot:product.kind==='SERVICE'?(publicConditionsFromRow(profiles.find(p=>p.id===product.id)?.service_schedule_profile)??null):null}
        if(line.unit_metadata_version===2){line.base_fulfilled='0';line.base_invoiced='0'}
        delete line.unit_revision
        group.components.push(componentFromLine(line,leaf));lines.push(line)
      }
    }
    groups.push(group);issues.push(...resolved.issues)
  }
  if(!allowIncomplete&&issues.length)fail('PACKAGE_SELECTION_INCOMPLETE','Completa los productos y cantidades de todos los paquetes')
  if(lines.length>100)fail('INVALID_PACKAGE','La cotización admite hasta 100 partidas reales',400)
  bounded(groups,'packageGroups')
  return{groups,lines,subtotal:money(lines.reduce((sum,line)=>sum.add(line.line_total),D(0))),issues}
}
function finalizePackageAmounts(raw,lines,{documentTotal}={}){
  const groups=structuredClone(readGroups(raw)),gross=lines.reduce((sum,line)=>sum.add(line.line_total),D(0)),total=D(documentTotal??gross)
  if(!total.isFinite()||total.lt(0)||total.gt(gross)||total.decimalPlaces()>2)review()
  let consumed=D(0)
  const net=new Map()
  for(const line of lines){
    const amount=gross.isZero()?D(0):cumulativeAmount(total,gross,line.line_total,consumed)
    consumed=consumed.add(line.line_total)
    if(line.package_component_key){if(net.has(line.package_component_key))review();net.set(line.package_component_key,amount)}
  }
  for(const group of groups)if(group.state==='COMPLETE'){
    let amount=D(0),netAmount=D(0)
    for(const c of group.components){if(!net.has(c.key))review();c.netLineTotal=money(net.get(c.key));amount=amount.add(c.lineTotal);netAmount=netAmount.add(c.netLineTotal)}
    if(!amount.eq(group.amount))review()
    group.netAmount=money(netAmount)
  }
  return groups
}
function assertPackageAgreement(document,{requireComplete=true,kind='DOCUMENT',allowPartial=false}={}){
  const groups=readGroups(document.package_groups),lines=document.lines??document.saleItems??[]
  if(!groups.length){if(lines.some(line=>line.package_component_key))review();return}
  if(requireComplete&&groups.some(group=>group.state!=='COMPLETE'))fail('PACKAGE_SELECTION_INCOMPLETE','Completa los productos y cantidades de todos los paquetes')
  if(kind!=='DOCUMENT'||allowPartial)review() // Partial sale agreement verification is added with its conversion boundary.
  const actual=new Map()
  for(const line of lines)if(line.package_component_key){if(actual.has(line.package_component_key))review();actual.set(line.package_component_key,line)}
  for(const group of groups)for(const c of group.components){
    const line=actual.get(c.key)
    if(!line||line.product_id!==c.productId||line.item_kind!==c.itemKind||line.item_name!==c.itemName||line.unit_label!==c.unitLabel||line.quantity_decimals!==c.quantityDecimals||
      !D(line.qty).eq(c.quantity)||!D(line.base_qty??line.qty).eq(c.baseQty)||!D(line.unit_price).eq(c.unitPrice)||!D(line.line_total).eq(c.lineTotal)||
      (line.unit_metadata_version??1)!==c.unitMetadataVersion||JSON.stringify(line.unit_snapshot)!==JSON.stringify(c.unitSnapshot))review()
    actual.delete(c.key)
  }
  if(actual.size)review()
  const expected=finalizePackageAmounts(groups,lines,{documentTotal:document.total})
  for(let i=0;i<groups.length;i++)if(groups[i].state==='COMPLETE'&&(!D(groups[i].netAmount).eq(expected[i].netAmount)||groups[i].components.some((c,j)=>!D(c.netLineTotal).eq(expected[i].components[j].netLineTotal))))review()
  const gross=lines.reduce((sum,line)=>sum.add(line.line_total),D(0))
  if(document.subtotal!=null&&!D(document.subtotal).eq(gross)||document.discount_total!=null&&!D(document.discount_total).eq(gross.sub(D(document.total))))review()
}
function publicPackageGroups(raw){
  return readGroups(raw).map(group=>({schemaVersion:1,groupId:group.groupId,
    name:group.name,variantName:group.variantName,currency:group.currency,state:group.state,estimatedAmount:group.estimatedAmount,
    amount:group.amount,netAmount:group.netAmount,
    issues:group.issues.map(issue=>({code:issue.code,message:issue.message,remainingQuantity:issue.remainingQuantity})),
    components:group.components.map(c=>({key:c.key,productId:c.productId,itemName:c.itemName,itemKind:c.itemKind,quantity:c.quantity,
      unitLabel:c.unitLabel,quantityDecimals:c.quantityDecimals,unitPrice:c.unitPrice,
      lineTotal:c.lineTotal,netLineTotal:c.netLineTotal,serviceConditions:c.serviceConditions?require('../modules/appointments/domain/publicServiceConditions').publicServiceConditions(c.serviceConditions):null}))}))
}
module.exports={buildPackageGroups,finalizePackageAmounts,assertPackageAgreement,assertFreePackageItems,packageLineFields,publicPackageGroups}
