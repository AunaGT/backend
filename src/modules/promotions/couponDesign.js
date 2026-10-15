
const FIELDS = ['company','companyLogo','name','description','benefit','code','validity','branches','limits','minimumPurchase','state','terms']
const HEX = /^#[0-9a-fA-F]{6}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const fail = field => { throw Object.assign(new Error('Revisa el diseño del cupón: ' + field), {status:400, field}) }
// Fase 2: claves opcionales; ausentes = comportamiento de la fase 1 (cupones guardados siguen válidos).
const keys = (value, names, path, optional = []) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype,null].includes(Object.getPrototypeOf(value)) ||
      Object.keys(value).some(key=>!names.includes(key)&&!optional.includes(key)) ||
      names.some(key=>!Object.hasOwn(value,key))) fail(path)
}
// Variantes que realmente existen por familia (mismo listado que el frontend).
const FONT_VARIANTS = {NotoSans:['normal','bold','italic','bolditalic'],Helvetica:['normal','bold','italic','bolditalic'],Montserrat:['normal','bold','italic','bolditalic'],Poppins:['normal','bold','italic','bolditalic'],PlayfairDisplay:['normal','bold','italic','bolditalic'],Oswald:['normal','bold'],RobotoSlab:['normal','bold'],BebasNeue:['normal'],Pacifico:['normal']}
const number = (value,min,max,path) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(path)
}
const choice = (value,values,path) => { if(!values.includes(value)) fail(path) }
const color = (value,path,nullable=false) => { if(!(nullable && value===null) && !(typeof value==='string' && HEX.test(value))) fail(path) }
const flag = (value,key,path) => { if(Object.hasOwn(value,key) && typeof value[key]!=='boolean') fail(path+'.'+key) }
const shadow = (value,path) => {
  if(value===null) return
  keys(value,['x','y','color','opacity'],path)
  number(value.x,-40,40,path+'.x'); number(value.y,-40,40,path+'.y'); color(value.color,path+'.color'); number(value.opacity,0,1,path+'.opacity')
}
const gradient = (value,path,angleRequired=true) => {
  if(value===null) return
  keys(value,angleRequired?['from','to','angle']:['from','to'],path,angleRequired?['via']:['via','angle'])
  color(value.from,path+'.from'); color(value.to,path+'.to')
  if(Object.hasOwn(value,'via')) { color(value.via,path+'.via'); if(!Object.hasOwn(value,'angle')) fail(path+'.angle') }
  if(Object.hasOwn(value,'angle')) number(value.angle,0,360,path+'.angle')
}
const image = (value,path) => {
  if(typeof value.assetId !== 'string' || !UUID.test(value.assetId)) fail(path+'.assetId')
  choice(value.fit,['contain','cover'],path+'.fit')
  number(value.focalX,0,1,path+'.focalX'); number(value.focalY,0,1,path+'.focalY')
}
function couponAssetIds(design) {
  if(!design) return []
  return [...new Set([...(design.background.kind==='image'?[design.background.assetId]:[]),
    ...design.elements.filter(e=>e.kind==='image').map(e=>e.assetId)])]
}
const COUPON_ASPECT={min:.5,max:3}
function parseCouponDesign(value) {
  if(value===null) return null
  keys(value,['printPreset','terms','background','elements'],'coupon_design',['aspect'])
  // Fase 3: proporción tomada de la imagen del cliente (ancho/alto); sin ella, 1000 × 720 de siempre.
  if(Object.hasOwn(value,'aspect')) number(value.aspect,COUPON_ASPECT.min,COUPON_ASPECT.max,'aspect')
  choice(value.printPreset,['standard','large'],'printPreset')
  if(typeof value.terms !== 'string' || value.terms.length>500) fail('terms')
  const bg=value.background
  const bgKeys=bg?.kind==='solid'?['kind','color']:bg?.kind==='gradient'?['kind','from','to']:['kind','assetId','fit','focalX','focalY']
  keys(bg,bgKeys,'background',bg?.kind==='gradient'?['via','angle']:[]); choice(bg.kind,['solid','gradient','image'],'background.kind')
  if(bg.kind==='solid') color(bg.color,'background.color')
  else if(bg.kind==='gradient') { const {kind,...rest}=bg; gradient(rest,'background',false) }
  else image(bg,'background')
  if(!Array.isArray(value.elements) || value.elements.length>30) fail('elements')
  const ids=new Set(), fields=new Set()
  for(const e of value.elements) {
    const path='elements.'+(e?.id || '?')
    const specific=e?.kind==='field'?['field','style']:e?.kind==='text'?['text','style']:e?.kind==='image'?['assetId','fit','focalX','focalY']:['shape','color','borderColor','borderWidth','radius']
    // Los campos obligatorios no se rotan: las comprobaciones de legibilidad suponen cajas alineadas.
    const optional=e?.kind==='field'?[]:e?.kind==='text'?['rotation']:e?.kind==='image'?['rotation','radius','shadow']:['rotation','borderStyle','gradient','shadow']
    keys(e,['id','kind','x','y','width','height','visible','locked','opacity',...specific],path,optional)
    if(Object.hasOwn(e,'rotation')) number(e.rotation,-180,180,path+'.rotation')
    choice(e.kind,['field','text','image','shape'],path+'.kind')
    if(typeof e.id!=='string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(e.id) || ids.has(e.id)) fail(path+'.id')
    ids.add(e.id)
    for(const key of ['x','y','width','height','opacity']) number(e[key],0,1,path+'.'+key)
    if(e.width<=0 || e.height<=0 || e.x+e.width>1.000000001 || e.y+e.height>1.000000001) fail(path+'.box')
    if(typeof e.visible!=='boolean' || typeof e.locked!=='boolean') fail(path+'.visible')
    if(e.kind==='field') {
      choice(e.field,FIELDS,path+'.field')
      if(fields.has(e.field)) fail(path+'.field')
      fields.add(e.field)
      if(['code','benefit'].includes(e.field) && (!e.visible || e.opacity!==1)) fail(path+'.'+e.field)
    }
    if(e.kind==='text' && (typeof e.text!=='string' || e.text.length>1000)) fail(path+'.text')
    if(e.kind==='text' || e.kind==='field') {
      const s=e.style
      keys(s,['font','fontSize','bold','color','align','lineHeight','padding','background','borderColor','borderWidth','radius'],path+'.style',['italic','underline','strike','uppercase','letterSpacing','strokeColor','strokeWidth','shadow'])
      choice(s.font,Object.keys(FONT_VARIANTS),path+'.font'); choice(s.align,['left','center','right'],path+'.align')
      for(const key of ['italic','underline','strike','uppercase']) flag(s,key,path)
      const variant=s.bold&&s.italic?'bolditalic':s.bold?'bold':s.italic?'italic':'normal'
      if(!FONT_VARIANTS[s.font].includes(variant)) fail(path+'.font')
      if(Object.hasOwn(s,'letterSpacing')) number(s.letterSpacing,-5,40,path+'.letterSpacing')
      if(Object.hasOwn(s,'strokeColor')) color(s.strokeColor,path+'.strokeColor',true)
      if(Object.hasOwn(s,'strokeWidth')) number(s.strokeWidth,0,10,path+'.strokeWidth')
      if(Object.hasOwn(s,'shadow')) shadow(s.shadow,path+'.shadow')
      if(typeof s.bold!=='boolean') fail(path+'.bold')
      number(s.fontSize,10,96,path+'.fontSize'); number(s.lineHeight,1,2,path+'.lineHeight')
      number(s.padding,0,30,path+'.padding'); number(s.borderWidth,0,20,path+'.borderWidth'); number(s.radius,0,100,path+'.radius')
      color(s.color,path+'.color'); color(s.background,path+'.background',true); color(s.borderColor,path+'.borderColor',true)
    } else if(e.kind==='image') {
      image(e,path)
      if(Object.hasOwn(e,'radius')) number(e.radius,0,100,path+'.radius')
      if(Object.hasOwn(e,'shadow')) shadow(e.shadow,path+'.shadow')
    } else {
      choice(e.shape,['rect','line','ellipse','star','badge'],path+'.shape'); color(e.color,path+'.color');color(e.borderColor,path+'.borderColor')
      number(e.borderWidth,0,20,path+'.borderWidth'); number(e.radius,0,100,path+'.radius')
      if(Object.hasOwn(e,'borderStyle')) choice(e.borderStyle,['solid','dashed','dotted'],path+'.borderStyle')
      if(Object.hasOwn(e,'gradient')) gradient(e.gradient,path+'.gradient')
      if(Object.hasOwn(e,'shadow')) shadow(e.shadow,path+'.shadow')
    }
  }
  if(!fields.has('code') || !fields.has('benefit')) fail('code/benefit')
  if(couponAssetIds(value).length>5) fail('images')
  return JSON.parse(JSON.stringify(value))
}
function assertCouponRestrictionFields(design,promotion) {
  if(!design) return
  const required=['code','benefit']
  if(promotion.start_date || promotion.end_date) required.push('validity')
  if(promotion.applies_to_all_branches===false) required.push('branches')
  if(Number(promotion.max_uses)>0 || Number(promotion.max_uses_per_customer)>0) required.push('limits')
  if(Number(promotion.min_purchase_amount)>0) required.push('minimumPurchase')
  if(promotion.active===false) required.push('state')
  for(const field of required) {
    const e=design.elements.find(e=>e.kind==='field' && e.field===field)
    if(!e || !e.visible || e.opacity!==1) fail(field)
  }
}

module.exports={parseCouponDesign,couponAssetIds,assertCouponRestrictionFields}
