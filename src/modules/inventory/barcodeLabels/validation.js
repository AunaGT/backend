const TYPES=['code128','ean13','ean8','upca'],FIELDS=['name','barcode','price','brand','size','company']
const SHELF_FIELDS=['price_label','price_secondary','price_secondary_label','price_tertiary','price_tertiary_label','promotion_until'],PRICE_TIERS=['LIST','WHOLESALE','PROMOTION']
const FONTS={NotoSans:4,Helvetica:4,Montserrat:4,Poppins:4,PlayfairDisplay:4,Oswald:2,RobotoSlab:2,BebasNeue:1,Pacifico:1}
const PAPER_SIZES={letter:[215.9,279.4],a4:[210,297],oficio:[215.9,330.2],legal:[215.9,355.6]}
function fail(field,message='Revisa este valor'){throw Object.assign(new Error(`${message}: ${field}`),{status:400,code:'INVALID_LABEL',field})}
function object(value,keys,field,optional=[]){
  if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value))||keys.some(k=>!Object.hasOwn(value,k))||Object.keys(value).some(k=>!keys.includes(k)&&!optional.includes(k)))fail(field)
}
function number(value,min,max,field,integer=false){if(typeof value!=='number'||!Number.isFinite(value)||value<min||value>max||integer&&!Number.isInteger(value))fail(field)}
function choice(value,values,field){if(!values.includes(value))fail(field)}
function string(value,max,field,min=0){if(typeof value!=='string'||value.length<min||value.length>max||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value))fail(field)}
function uuid(value,field){if(typeof value!=='string'||!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value))fail(field)}
function color(value,field,nullable=false){if(!(nullable&&value===null)&&!(typeof value==='string'&&/^#[\da-f]{6}$/i.test(value)))fail(field)}
const textStyle=(bold=false,fontSize=9)=>({font:'NotoSans',fontSize,bold,color:'#111111',align:'left',lineHeight:1.15,padding:0,background:null,borderColor:null,borderWidth:0,radius:0})
function style(value,field){
  object(value,['font','fontSize','bold','color','align','lineHeight','padding','background','borderColor','borderWidth','radius'],field,['italic','underline','strike','uppercase','letterSpacing'])
  choice(value.font,Object.keys(FONTS),field+'.font');number(value.fontSize,6,36,field+'.fontSize')
  for(const k of ['bold','italic','underline','strike','uppercase'])if(value[k]!==undefined&&typeof value[k]!=='boolean')fail(field+'.'+k)
  if(FONTS[value.font]===1&&(value.bold||value.italic)||FONTS[value.font]===2&&value.italic)fail(field+'.font','La fuente no incluye esta variante')
  color(value.color,field+'.color');color(value.background,field+'.background',true);color(value.borderColor,field+'.borderColor',true)
  choice(value.align,['left','center','right'],field+'.align');number(value.lineHeight,1,2,field+'.lineHeight');number(value.padding,0,10,field+'.padding')
  number(value.borderWidth,0,3,field+'.borderWidth');number(value.radius,0,10,field+'.radius')
  if(value.letterSpacing!==undefined)number(value.letterSpacing,-1,4,field+'.letterSpacing')
}
const paintedBox=(e,design)=>{const stroke=e.kind==='shape'?e.borderWidth:e.kind==='text'||e.kind==='field'?e.style.borderColor?e.style.borderWidth:0:0,half=(e.kind==='shape'&&e.shape==='line'?Math.max(.1,stroke*25.4/72):stroke*25.4/72)/2;return{...e,x:e.x-half/design.widthMm,y:e.y-half/design.heightMm,width:e.width+2*half/design.widthMm,height:e.height+2*half/design.heightMm}}
const overlaps=(a,b)=>a.x<b.x+b.width-1e-8&&a.x+a.width>b.x+1e-8&&a.y<b.y+b.height-1e-8&&a.y+a.height>b.y+1e-8
function parseLabelDesign(value){
  object(value,['schemaVersion','widthMm','heightMm','barcodeType','elements'],'design',['purpose','primaryTier','priceTiers']);choice(value.schemaVersion,[1],'schemaVersion')
  number(value.widthMm,20,200,'widthMm');number(value.heightMm,10,200,'heightMm');choice(value.barcodeType,TYPES,'barcodeType')
  if(!Array.isArray(value.elements)||value.elements.length<2||value.elements.length>20)fail('elements')
  const shelf=value.purpose==='shelf'
  if(value.purpose!==undefined&&!shelf)fail('purpose')
  if(shelf){parsePriceTiers(value.priceTiers);choice(value.primaryTier,PRICE_TIERS,'primaryTier')}else if(value.primaryTier!==undefined||value.priceTiers!==undefined)fail('purpose')
  const ids=new Set(),fields=new Set();let barcode,readable
  for(const e of value.elements){
    const common=['id','x','y','width','height','visible','locked','kind']
    object(e,common.concat(e.kind==='field'?['field','style']:e.kind==='text'?['text','style']:e.kind==='shape'?['shape','color','borderColor','borderWidth']:[]),'element')
    string(e.id,64,'id',1);if(!/^[\w-]+$/.test(e.id)||ids.has(e.id))fail('id');ids.add(e.id)
    choice(e.kind,['barcode','field','text','shape'],'kind')
    for(const k of ['x','y'])number(e[k],0,1,k)
    for(const k of ['width','height'])number(e[k],.001,1,k)
    if(e.x+e.width>1.00000001||e.y+e.height>1.00000001)fail(e.id,'La capa sale de la etiqueta')
    if(typeof e.visible!=='boolean'||typeof e.locked!=='boolean')fail(e.id)
    if(e.kind==='barcode'){if(barcode||!e.visible)fail('barcode','El código de barras es obligatorio y único');barcode=e}
    if(e.kind==='field'){choice(e.field,shelf?[...FIELDS,...SHELF_FIELDS]:FIELDS,'field');if(fields.has(e.field))fail('field');fields.add(e.field);style(e.style,e.id);if(e.field==='barcode'){readable=e;if(!e.visible||e.style.uppercase||e.style.color.toLowerCase()!=='#111111'&&e.style.color.toLowerCase()!=='#000000'||e.style.background!==null&&e.style.background.toLowerCase()!=='#ffffff'||e.style.strike||e.style.borderWidth>0)fail(e.id,'Conserva el valor original del código legible')}}
    if(e.kind==='text'){string(e.text,500,e.id);style(e.style,e.id)}
    if(e.kind==='shape'){choice(e.shape,['rect','line','ellipse'],'shape');color(e.color,'color');color(e.borderColor,'borderColor');number(e.borderWidth,0,3,'borderWidth')}
  }
  if(shelf){for(const field of ['name','price'])if(!value.elements.some(e=>e.kind==='field'&&e.field===field&&e.visible))fail(field,'Mantén el producto y precio principal')}
  if((!shelf||barcode||readable)&&(!barcode||!readable))fail('elements','Mantén las barras y el código legible')
  for(const e of value.elements){if(!e.visible)continue;const painted=paintedBox(e,value);if(painted.x<-1e-8||painted.y<-1e-8||painted.x+painted.width>1.00000001||painted.y+painted.height>1.00000001)fail(e.id,'El borde sale de la etiqueta')}
  for(const e of value.elements)if(barcode&&e!==barcode&&e.visible&&overlaps(paintedBox(e,value),barcode))fail(e.id,'La capa tapa el código o su zona blanca')
  for(const e of value.elements)if(readable&&e!==readable&&e.visible&&overlaps(paintedBox(e,value),readable))fail(e.id,'La capa tapa el código legible')
  return structuredClone(value)
}
function createLabelTemplate(preset='product'){
  choice(preset,['essential','product','price'],'template')
  const box=(id,kind,x,y,width,height,rest={})=>({id,kind,x,y,width,height,visible:true,locked:false,...rest})
  const elements=[box('bars','barcode',.03,.27,.94,.44),box('value','field',.03,.75,.94,.12,{field:'barcode',style:{...textStyle(false,8),align:'center'}})]
  if(preset!=='essential')elements.unshift(box('name','field',.03,.03,.94,.22,{field:'name',style:textStyle(true,9)}))
  if(preset==='price')elements.push(box('price','field',.03,.89,.94,.1,{field:'price',style:{...textStyle(true,8),align:'right'}}))
  return {schemaVersion:1,widthMm:70,heightMm:35,barcodeType:'code128',elements}
}
function parsePriceTiers(value){
  if(!Array.isArray(value)||value.length<1||value.length>3||new Set(value).size!==value.length||value.some(v=>!PRICE_TIERS.includes(v)))fail('priceTiers','Selecciona al menos una tarifa válida')
  return [...value]
}
function createShelfLabelTemplate(preset='price'){
  choice(preset,['essential','product','price'],'template')
  const field=(id,field,x,y,width,height,fontSize,bold=false,color='#111111')=>({id,kind:'field',field,x,y,width,height,visible:true,locked:false,style:{...textStyle(bold,fontSize),color}})
  if(preset==='price')return{schemaVersion:1,purpose:'shelf',widthMm:80,heightMm:35,barcodeType:'code128',primaryTier:'LIST',priceTiers:['LIST','WHOLESALE','PROMOTION'],elements:[
    {id:'frame',kind:'shape',shape:'rect',x:.01,y:.02,width:.98,height:.96,visible:true,locked:false,color:'#ffffff',borderColor:'#64748b',borderWidth:.4},
    field('name','name',.04,.06,.92,.23,9,true),
    ...['price','price_secondary','price_tertiary'].flatMap((price,i)=>[
      field(['caption','second-caption','third-caption'][i],['price_label','price_secondary_label','price_tertiary_label'][i],.04+i*.315,.36,.29,.1,7,true),
      field(['price','second-price','third-price'][i],price,.04+i*.315,.49,.29,.24,14,true)
    ]),
    ...[.342,.657].map((x,i)=>({id:'divider-'+i,kind:'shape',shape:'line',x,y:.34,width:.001,height:.42,visible:true,locked:false,color:'#ffffff',borderColor:'#94a3b8',borderWidth:.4})),
    field('validity','promotion_until',.04,.84,.92,.12,6)
  ]}
  return{schemaVersion:1,purpose:'shelf',widthMm:80,heightMm:50,barcodeType:'code128',primaryTier:'LIST',priceTiers:preset==='essential'?['LIST']:['LIST','WHOLESALE'],elements:[
    field('name','name',.04,.04,.92,.19,10,true),
    field('caption','price_label',.04,.25,.92,.07,8,true,preset==='price'?'#b91c1c':'#475569'),
    field('price','price',.04,.33,.92,.27,preset==='essential'?30:28,true,preset==='price'?'#b91c1c':'#111111'),
    field('second-caption','price_secondary_label',.04,.65,.44,.07,7),
    field('second-price','price_secondary',.04,.73,.44,.16,15,true),
    field('third-caption','price_tertiary_label',.52,.65,.44,.07,7),
    field('third-price','price_tertiary',.52,.73,.44,.16,15,true),
    field('validity','promotion_until',.04,.92,.92,.07,6)
  ]}
}
function defaultPaper(){return {format:'letter',orientation:'portrait',widthMm:215.9,heightMm:279.4,margins:{top:10,right:10,bottom:10,left:10},gapX:3,gapY:3,includeGuide:true}}
function parsePaperSettings(value){
  object(value,['format','orientation','widthMm','heightMm','margins','gapX','gapY','includeGuide'],'paper')
  choice(value.format,[...Object.keys(PAPER_SIZES),'custom','thermal'],'format');choice(value.orientation,['portrait','landscape'],'orientation')
  number(value.widthMm,20,600,'paper.widthMm');number(value.heightMm,20,600,'paper.heightMm')
  object(value.margins,['top','right','bottom','left'],'margins');for(const k of Object.keys(value.margins))number(value.margins[k],0,200,'margins.'+k)
  number(value.gapX,0,100,'gapX');number(value.gapY,0,100,'gapY');if(typeof value.includeGuide!=='boolean')fail('includeGuide')
  const size=PAPER_SIZES[value.format];if(size&&(value.widthMm!==size[0]||value.heightMm!==size[1]))fail('paper','Selecciona las medidas del formato indicado')
  return structuredClone(value)
}
function computeLabelGrid(design,paper,headerHeightMm=12){
  parseLabelDesign(design);parsePaperSettings(paper)
  if(paper.format==='thermal')return{widthMm:design.widthMm,heightMm:design.heightMm,columns:1,rows:1,capacity:1,left:0,top:0,headerHeightMm:0}
  const [widthMm,heightMm]=paper.orientation==='landscape'?[paper.heightMm,paper.widthMm]:[paper.widthMm,paper.heightMm]
  const width=widthMm-paper.margins.left-paper.margins.right,height=heightMm-paper.margins.top-paper.margins.bottom-headerHeightMm
  const columns=Math.floor((width+paper.gapX+1e-8)/(design.widthMm+paper.gapX)),rows=Math.floor((height+paper.gapY+1e-8)/(design.heightMm+paper.gapY))
  if(columns<1||rows<1)fail('paper','La etiqueta no cabe: amplía la hoja o reduce márgenes')
  return{widthMm,heightMm,columns,rows,capacity:columns*rows,left:paper.margins.left,top:paper.margins.top+headerHeightMm,headerHeightMm}
}
function parseLayoutInput(raw){object(raw,['expectedRevision','design','defaultPaper'],'layout');number(raw.expectedRevision,0,Number.MAX_SAFE_INTEGER,'expectedRevision',true);return{...raw,design:parseLabelDesign(raw.design),defaultPaper:parsePaperSettings(raw.defaultPaper)}}
function parsePreparationInput(raw,shelf=false){
  object(raw,['requestKey','scope','items','design','paper','confirmAssignments'],'preparation');uuid(raw.requestKey,'requestKey')
  object(raw.scope,['branchId','inBranch'],'scope',['warehouseId','locationId']);uuid(raw.scope.branchId,'scope.branchId');for(const k of ['warehouseId','locationId'])if(raw.scope[k]!==undefined)uuid(raw.scope[k],'scope.'+k)
  if(typeof raw.scope.inBranch!=='boolean'||typeof raw.confirmAssignments!=='boolean')fail('scope/confirmation')
  const design=parseLabelDesign(raw.design),paper=parsePaperSettings(raw.paper)
  if((design.purpose==='shelf')!==shelf)fail('purpose','Usa la opción de impresión correspondiente')
  if(!Array.isArray(raw.items)||raw.items.length<1||raw.items.length>100)fail('items','Selecciona de 1 a 100 productos')
  const seen=new Set();let total=0
  const items=raw.items.map(i=>{
    object(i,['productId','copies','expectedBarcode','assignment'],'item',['presentation_id','unit_revision',...(shelf?['priceTiers']:[])]);uuid(i.productId,'productId');if(i.presentation_id!=null)uuid(i.presentation_id,'presentation_id');if(i.unit_revision!==undefined)number(i.unit_revision,1,Number.MAX_SAFE_INTEGER,'unit_revision',true);const identity=i.productId+':'+(i.presentation_id??'BASE');if(seen.has(identity))fail(i.productId,'Producto/presentación repetido');seen.add(identity)
    number(i.copies,1,1000,'copies',true);total+=i.copies;if(i.expectedBarcode!==null)string(i.expectedBarcode,100,'expectedBarcode',1)
    object(i.assignment,['mode'],'assignment',['value']);choice(i.assignment.mode,['keep','auto','manual'],'mode')
    const {mode}=i.assignment
    if(shelf){if(mode!=='keep'||i.assignment.value!==undefined)fail(i.productId,'Las etiquetas de precio no asignan códigos');return{...structuredClone(i),...(i.priceTiers?{priceTiers:parsePriceTiers(i.priceTiers)}:{})}}
    if(mode==='keep'){if(!i.expectedBarcode||i.assignment.value!==undefined)fail(i.productId,'El código existente debe conservarse')}
    else if(i.expectedBarcode!==null||!raw.confirmAssignments)fail(i.productId,'Confirma la asignación de códigos faltantes')
    if(mode==='auto'&&(design.barcodeType!=='code128'||i.assignment.value!==undefined))fail(i.productId,'La asignación automática utiliza Code 128')
    if(mode==='manual'){string(i.assignment.value,50,'value',1);const value=i.assignment.value.trim();if(!value||!/^[\x20-\x7e]+$/.test(value))fail('value');return{...i,assignment:{mode,value}}}
    return structuredClone(i)
  })
  if(total>5000)fail('copies','Divide la impresión: máximo 5,000 etiquetas')
const grid=computeLabelGrid(design,paper),pages=shelf?Math.ceil(total/grid.capacity):items.reduce((n,i)=>n+Math.ceil(i.copies/grid.capacity),0)
  if(pages>500)fail('copies','Divide la impresión: máximo 500 páginas de etiquetas')
  return{...structuredClone(raw),items,design,paper}
}
const parseShelfPreparationInput=raw=>parsePreparationInput(raw,true)
module.exports={TYPES,FIELDS,FONTS,PAPER_SIZES,textStyle,parseLabelDesign,createLabelTemplate,defaultPaper,parsePaperSettings,computeLabelGrid,parseLayoutInput,parsePreparationInput,createShelfLabelTemplate,parsePriceTiers,PRICE_TIERS,SHELF_FIELDS,parseShelfPreparationInput,fail}
