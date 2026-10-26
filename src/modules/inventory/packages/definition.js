const {parseDecimal}=require('../../../services/units/quantity')
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const BYTES=256*1024
function invalid(path,message='Revisa la configuración del paquete') {
  throw Object.assign(new Error(message),{status:400,code:'INVALID_PACKAGE',fields:{[path]:message}})
}
function object(raw,keys,path) {
  if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.getPrototypeOf(raw)!==Object.prototype)invalid(path,'Envía un objeto válido')
  const descriptors=Object.getOwnPropertyDescriptors(raw)
  for(const key of Reflect.ownKeys(descriptors)) {
    if(typeof key!=='string'||!keys.includes(key)||!Object.hasOwn(descriptors[key],'value'))invalid(path,'El objeto contiene campos no permitidos')
  }
  return raw
}
function text(value,path,max,required=true) {
  if(value===undefined&&!required)return ''
  if(typeof value!=='string'||value.length>max||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)||required&&!value.trim())invalid(path,`Ingresa un texto de hasta ${max} caracteres`)
  return value.trim()
}
function uuid(value,path) {
  if(typeof value!=='string'||!UUID.test(value))invalid(path,'Selecciona un registro válido')
  return value.toLowerCase()
}
function integer(value,path,min,max) {
  if(!Number.isSafeInteger(value)||value<min||value>max)invalid(path,`Indica un entero entre ${min} y ${max}`)
  return value
}
function decimal(value,path,{decimals=6,allowZero=false,max='99999999.999999',nullable=false,money=false}={}) {
  if(nullable&&(value===null||value===undefined||value===''))return null
  if(typeof value!=='string'||value.length>128||!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value))invalid(path,'Indica un decimal válido como texto')
  try {
    const parsed=parseDecimal(value,{decimals,allowZero,max})
    return money?parsed.toFixed(2):parsed.toFixed()
  }catch{invalid(path,'El número está fuera del rango o precisión permitidos')}
}
function array(value,path,max,{optional=false}={}) {
  if(value===undefined&&optional)return []
  if(!Array.isArray(value)||value.length>max)invalid(path,`Agrega hasta ${max} elementos`)
  return value
}
function bounded(value,path='definition') {
  if(Buffer.byteLength(JSON.stringify(value))>BYTES)invalid(path,'El paquete supera 256 KiB')
  return value
}
function imageUrl(value) {
  if(value===null||value===undefined||value==='')return null
  text(value,'imageUrl',2048)
  try {
    const url=new URL(value)
    if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)invalid('imageUrl')
    return url.href
  }catch{invalid('imageUrl','Usa una imagen HTTPS sin credenciales ni parámetros privados')}
}
function parsePackageDefinition(raw,{complete=true}={}) {
  object(raw,['schemaVersion','name','description','imageUrl','currency','variants'],'definition')
  if(raw.schemaVersion!==1)invalid('schemaVersion','Versión de definición no compatible')
  const name=text(raw.name,'name',150,complete),currency=text(raw.currency,'currency',3)
  if(!/^[A-Z]{3}$/.test(currency))invalid('currency','Indica una moneda de tres letras')
  const ids=new Set()
  const unique=(value,path)=>{
    const id=uuid(value,path)
    if(ids.has(id))invalid(path,'Los identificadores de la definición no pueden repetirse')
    ids.add(id);return id
  }
  const productRef=(value,path)=>({
    productId:!complete&&(value.productId==null||value.productId==='')?null:uuid(value.productId,`${path}.productId`),
    presentationId:value.presentationId==null?null:uuid(value.presentationId,`${path}.presentationId`),
    unitRevision:!complete&&value.unitRevision==null?null:integer(value.unitRevision,`${path}.unitRevision`,1,2147483647),
  })
  const weight=(value,path)=>decimal(value,path,{decimals:4,allowZero:true,max:'1000000',nullable:!complete})
  const variants=array(raw.variants,'variants',20,{optional:!complete}).map((value,index)=>{
    const path=`variants.${index}`
    object(value,['id','name','price','components','choices'],path)
    const id=unique(value.id,`${path}.id`)
    const components=array(value.components,`${path}.components`,50,{optional:!complete}).map((component,i)=>{
      const p=`${path}.components.${i}`
      object(component,['id','productId','quantity','presentationId','unitRevision','weight'],p)
      return{id:unique(component.id,`${p}.id`),...productRef(component,p),
        quantity:decimal(component.quantity,`${p}.quantity`,{nullable:!complete}),weight:weight(component.weight,`${p}.weight`)}
    })
    const choices=array(value.choices,`${path}.choices`,10,{optional:!complete}).map((choice,i)=>{
      const p=`${path}.choices.${i}`
      object(choice,['id','name','totalQuantity','maxDistinct','weight','options'],p)
      const choiceId=unique(choice.id,`${p}.id`),refs=new Set()
      const options=array(choice.options,`${p}.options`,50,{optional:!complete}).map((option,j)=>{
        const o=`${p}.options.${j}`
        object(option,['id','productId','presentationId','unitRevision'],o)
        const out={id:unique(option.id,`${o}.id`),...productRef(option,o)}
        if(out.productId){
          const key=`${out.productId}:${out.presentationId??'base'}`
          if(refs.has(key))invalid(o,'Una opción de producto y presentación no puede repetirse')
          refs.add(key)
        }
        return out
      })
      const maxDistinct=!complete&&choice.maxDistinct==null?null:integer(choice.maxDistinct,`${p}.maxDistinct`,1,50)
      if(complete&&(!options.length||maxDistinct>options.length))invalid(p,'Selecciona opciones suficientes para el límite indicado')
      return{id:choiceId,name:text(choice.name,`${p}.name`,150,complete),totalQuantity:decimal(choice.totalQuantity,`${p}.totalQuantity`,{nullable:!complete}),
        maxDistinct,weight:weight(choice.weight,`${p}.weight`),options}
    })
    const price=decimal(value.price,`${path}.price`,{decimals:2,allowZero:true,max:'9999999999.99',money:true,nullable:!complete})
    if(complete){
      if(!components.length&&!choices.length)invalid(path,'Agrega productos, servicios o elecciones al paquete')
      if(components.length+choices.length>100)invalid(path,'El paquete excede el límite de partidas')
      const positive=[...components,...choices].some(item=>parseDecimal(item.weight,{decimals:4,allowZero:true,max:'1000000'}).gt(0))
      if(price!=='0.00'&&!positive)invalid(path,'Distribuye el precio de venta entre los componentes del paquete')
    }
    return{id,name:text(value.name,`${path}.name`,150,complete),price,components,choices}
  })
  if(complete&&!variants.length)invalid('variants','Agrega al menos una variante')
  return bounded({schemaVersion:1,name,description:text(raw.description,'description',2000,false),imageUrl:imageUrl(raw.imageUrl),currency,variants})
}
module.exports={parsePackageDefinition,invalid,object,text,uuid,integer,decimal,array,bounded}
