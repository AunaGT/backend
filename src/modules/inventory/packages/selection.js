const {parseQuantity}=require('../../../services/units/quantity')
const {parsePackageDefinition,invalid,object,uuid,integer,decimal,array,bounded}=require('./definition')
function unique(values,key,path) {
  if(new Set(values.map(value=>value[key])).size!==values.length)invalid(path,'No repitas una selección')
}
function parsePackageSelections(raw) {
  const groups=array(raw,'packages',100).map((value,index)=>{
    const path=`packages.${index}`
    object(value,['groupId','packageId','version','variantId','choices'],path)
    const choices=array(value.choices,`${path}.choices`,10).map((choice,i)=>{
      const p=`${path}.choices.${i}`
      object(choice,['choiceId','items'],p)
      const items=array(choice.items,`${p}.items`,50).map((item,j)=>{
        const l=`${p}.items.${j}`;object(item,['optionId','quantity'],l)
        return{optionId:uuid(item.optionId,`${l}.optionId`),quantity:decimal(item.quantity,`${l}.quantity`)}
      })
      unique(items,'optionId',p)
      return{choiceId:uuid(choice.choiceId,`${p}.choiceId`),items}
    })
    unique(choices,'choiceId',path)
    return{groupId:uuid(value.groupId,`${path}.groupId`),packageId:uuid(value.packageId,`${path}.packageId`),
      version:integer(value.version,`${path}.version`,1,2147483647),variantId:uuid(value.variantId,`${path}.variantId`),choices}
  })
  unique(groups,'groupId','packages')
  return bounded(groups,'packages')
}
function validatePackageSelection(rawDefinition,rawSelection) {
  const definition=parsePackageDefinition(rawDefinition,{complete:true}),selection=parsePackageSelections([rawSelection])[0]
  const variant=definition.variants.find(item=>item.id===selection.variantId)
  if(!variant)invalid('variantId','La variante no pertenece a este paquete')
  for(const choice of selection.choices)if(!variant.choices.some(item=>item.id===choice.choiceId))invalid('choices','La selección no pertenece a esta variante')
  const leaves=variant.components.map(component=>({key:`${selection.groupId}:${component.id}`,productId:component.productId,
    quantity:component.quantity,presentationId:component.presentationId,unitRevision:component.unitRevision,weight:component.weight,allocationId:component.id}))
  const issues=[]
  for(const choice of variant.choices){
    const items=selection.choices.find(item=>item.choiceId===choice.id)?.items??[]
    if(items.length>choice.maxDistinct)invalid('choices',`Elige hasta ${choice.maxDistinct} opciones de ${choice.name}`)
    let total=parseQuantity('0',{allowZero:true})
    for(const item of items){
      const option=choice.options.find(option=>option.id===item.optionId)
      if(!option)invalid('choices','El producto seleccionado no pertenece al grupo')
      total=total.add(item.quantity)
      leaves.push({key:`${selection.groupId}:${option.id}`,productId:option.productId,quantity:item.quantity,
        presentationId:option.presentationId,unitRevision:option.unitRevision,weight:choice.weight,allocationId:choice.id})
    }
    if(total.gt(choice.totalQuantity))invalid('choices',`La cantidad de ${choice.name} supera lo contratado`)
    if(total.lt(choice.totalQuantity))issues.push({code:'PACKAGE_SELECTION_INCOMPLETE',choiceId:choice.id,
      message:`Falta completar la selección de ${choice.name}`,remainingQuantity:parseQuantity(choice.totalQuantity).sub(total).toFixed()})
  }
  if(leaves.length>100)invalid('packages','El paquete genera más de 100 partidas')
  return{state:issues.length?'INCOMPLETE':'COMPLETE',issues,leaves:issues.length?[]:leaves}
}
module.exports={parsePackageSelections,validatePackageSelection}
