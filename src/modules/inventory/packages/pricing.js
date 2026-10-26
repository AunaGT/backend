const {parseDecimal,parseQuantity,lineTotal}=require('../../../services/units/quantity')
const {invalid}=require('./definition')
const compare=(a,b)=>a<b?-1:a>b?1:0
const zero=()=>parseQuantity('0',{allowZero:true})
function split(amount,entries) {
  const total=entries.reduce((sum,entry)=>sum.add(entry.weight),zero())
  if(total.isZero()&&!amount.isZero())invalid('weight','Distribuye el precio del paquete antes de cotizarlo')
  let weight=zero(),assigned=zero()
  return entries.map((entry,index)=>{
    weight=weight.add(entry.weight)
    const end=total.isZero()?zero():index===entries.length-1?amount:amount.mul(weight).div(total).toDecimalPlaces(2,4)
    const allocated=end.sub(assigned);assigned=end
    return{...entry,amount:allocated}
  })
}
function allocatePackagePrice({amount,leaves}) {
  if(typeof amount!=='string')invalid('amount','Indica un importe decimal como texto')
  let price
  try{price=parseDecimal(amount,{decimals:2,allowZero:true,max:'9999999999.99'})}catch{invalid('amount','Precio fuera de rango')}
  if(!Array.isArray(leaves)||!leaves.length||leaves.length>100)invalid('leaves','Agrega entre 1 y 100 componentes')
  const groups=new Map(),keys=new Set()
  for(const leaf of leaves){
    if(!leaf||typeof leaf.key!=='string'||!leaf.key||leaf.key.length>73||keys.has(leaf.key))invalid('leaves','Clave de componente inválida o repetida')
    keys.add(leaf.key)
    const id=leaf.allocationId??leaf.key
    if(typeof id!=='string'||!id||id.length>73)invalid('leaves','Distribución inválida')
    let quantity,weight
    try{quantity=parseQuantity(leaf.quantity);weight=parseDecimal(leaf.weight,{decimals:4,allowZero:true,max:'1000000'})}catch{invalid('leaves','Cantidad o ponderación fuera de rango')}
    if(!groups.has(id))groups.set(id,{id,weight,leaves:[]})
    const group=groups.get(id)
    if(!group.weight.eq(weight))invalid('weight','Las opciones de un grupo deben compartir ponderación')
    group.leaves.push({key:leaf.key,weight:quantity,quantity})
  }
  const out=[]
  for(const group of split(price,[...groups.values()].sort((a,b)=>compare(a.id,b.id)))) {
    for(const leaf of split(group.amount,group.leaves.sort((a,b)=>compare(a.key,b.key)))){
      const assigned=leaf.amount.toFixed(2),unitPrice=leaf.amount.div(leaf.quantity).toDecimalPlaces(18,4).toFixed()
      try{if(lineTotal(leaf.quantity,unitPrice)!==assigned)throw Error('Unrepresentable price')}
      catch{throw Object.assign(new Error('Revisa la distribución del precio: no se puede representar sin alterar el importe'),{status:409,code:'PACKAGE_PRICE_REVIEW_REQUIRED'})}
      out.push({key:leaf.key,unitPrice,lineTotal:assigned})
    }
  }
  return out.sort((a,b)=>compare(a.key,b.key))
}
module.exports={allocatePackagePrice}
