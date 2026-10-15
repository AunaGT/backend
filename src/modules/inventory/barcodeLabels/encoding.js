const bwip=require('bwip-js')
const {TYPES,fail}=require('./validation')
function encodeLabelBarcode(value,type,box){
  if(typeof value!=='string'||!value.length||value.length>100||!/^[\x20-\x7e]+$/.test(value)||!TYPES.includes(type))fail('barcode','Código no compatible con esta simbología')
  if(type!=='code128'){
    const size={ean13:13,ean8:8,upca:12}[type]
    if(!new RegExp(`^\\d{${size}}$`).test(value))fail('barcode',`Ingresa ${size} dígitos con su dígito de control`)
    let sum=0;for(let i=value.length-2,weight=3;i>=0;i--,weight=4-weight)sum+=Number(value[i])*weight
    if((10-sum%10)%10!==Number(value.at(-1)))fail('barcode','Dígito de control incorrecto')
  }
  if(!Number.isFinite(box.width)||!Number.isFinite(box.height)||box.width<=0||box.height<=0)fail('barcode','Tamaño inválido')
  let raw;try{raw=bwip.raw({bcid:type,text:value,includetext:true})[0]}catch{fail('barcode','No se puede codificar este valor')}
  const quiet={code128:[10,10],ean13:[11,7],ean8:[7,7],upca:[9,9]}[type]
  const modules=raw.sbs.reduce((a,b)=>a+b,0),minX=type==='code128'?.25:.33
  // Fit conservatively at the minimum module width; wider boxes add white space, never stretch bars.
  const symbolWidth=(modules+quiet[0]+quiet[1])*minX,minHeight=type==='code128'?10:type==='ean8'?18.23:22.85
  if(box.width+1e-8<symbolWidth||box.height+1e-8<minHeight)fail('barcode',`Amplía el bloque: requiere ${symbolWidth.toFixed(1)} × ${minHeight.toFixed(1)} mm`)
  const maxTop=Math.max(...raw.bhs.map((h,i)=>h+raw.bbs[i])),scale=minHeight/maxTop
  let x=(box.width-symbolWidth)/2+quiet[0]*minX,bar=0;const bars=[]
  raw.sbs.forEach((w,i)=>{if(i%2===0){bars.push({x,y:(maxTop-raw.bbs[bar]-raw.bhs[bar])*scale,width:w*minX,height:raw.bhs[bar]*scale});bar++}x+=w*minX})
  return{value,type,bars,widthMm:box.width,heightMm:box.height,protectedBox:{x:0,y:0,width:box.width,height:box.height}}
}
module.exports={encodeLabelBarcode}
