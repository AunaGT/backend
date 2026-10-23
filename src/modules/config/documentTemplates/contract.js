const crypto = require('node:crypto')

const LIMITS = Object.freeze({xmlBytes:262144, depth:12, nodes:200, snapshotBytes:2097152, resourceBytes:26214400, pdfBytes:33554432})
const PAPER = Object.freeze({LETTER:{width:612,height:792}, A4:{width:595.276,height:841.89}, RECEIPT_80:{width:226.772,height:841.89}})
const BLOCKS = Object.freeze({
  HEADER:{required:true, settings:{title:'text',showLogo:'boolean',alignment:['left','center','right'],images:'images'}},
  EMITTER:{required:true,settings:{}}, RECEIVER:{required:true,settings:{}},
  DETAILS:{required:true,settings:{columns:'columns',columnStyles:'columnStyles'}}, TOTALS:{required:true,settings:{}},
  NOTES:{required:false,settings:{text:'text'}}, FISCAL:{required:false,settings:{}}, FOOTER:{required:true,settings:{text:'text',images:'images'}},
})
const THEME = Object.freeze({fontFamily:['Helvetica','Montserrat','Courier'],fontSize:[9,14],accentColor:'color',textColor:'color',spacing:[2,16]})
const schemaManifest = Object.freeze({schemaVersion:1,rendererVersion:'INVOICE_BLOCKS_V2',baseVersions:[1,2],root:'plantilla-factura',
  formats:Object.keys(PAPER),purposes:['INTERNAL_RECEIPT','FEL_INVOICE'],bases:['CLASSIC','COMPACT','CORPORATE'],
  blocks:BLOCKS,theme:THEME,appearance:{...THEME,headerText:'text',footerText:'text',preferredFormat:Object.keys(PAPER)},columns:['description','quantity','unit','price','total','number','discount'],
  conditions:['ALWAYS','HAS_NOTE','HAS_DISCOUNT'],limits:LIMITS,
  xml:{rootAttributes:['version','purpose','format','formato','base','base-version','margin'],themeTag:'tema',blockTag:'bloque',blockAttributes:['id','kind','tipo','when','condicion'],columnAttributes:['key','label','width','align','when','condicion']},
})
function invalid(path,message,location={}) {
  return Object.assign(new Error(message),{status:400,code:'TEMPLATE_INVALID',diagnostics:[{path,...location,message}]})
}
function check(ok,path,message){if(!ok)throw invalid(path,message)}
function keys(value,allowed,path) {
  check(value && typeof value==='object'&&!Array.isArray(value),path,'Se esperaba un objeto')
  for(const k of Object.keys(value))check(allowed.includes(k),`${path}.${k}`,'Campo no admitido')
}
function luminance(hex) {
  const rgb=hex.slice(1).match(/../g).map(x=>parseInt(x,16)/255).map(x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4)
  return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722
}
function validateTheme(theme,path='themeOverrides') {
  keys(theme,Object.keys(THEME),path)
  for(const [key,value] of Object.entries(theme)) {
    const rule=THEME[key]
    if(rule==='color') check(typeof value==='string'&&/^#[\da-f]{6}$/i.test(value),`${path}.${key}`,'Usa un color hexadecimal de seis dígitos')
    else if(typeof rule[0]==='number')check(typeof value==='number'&&Number.isFinite(value)&&value>=rule[0]&&value<=rule[1],`${path}.${key}`,`Valor permitido: ${rule[0]}–${rule[1]}`)
    else check(rule.includes(value),`${path}.${key}`,'Valor no admitido')
  }
  for(const key of ['textColor','accentColor']) if(theme[key]) check(1.05/(luminance(theme[key])+.05)>=4.5,`${path}.${key}`,'El contraste sobre papel blanco debe ser al menos 4.5:1')
  return theme
}
function validateDesign(design) {
  check(Buffer.byteLength(JSON.stringify(design)??'')<=LIMITS.xmlBytes,'design','El diseño supera 256 KiB')
  keys(design,['schemaVersion','purpose','paper','base','themeOverrides','blocks'],'design')
  check(design.schemaVersion===1,'schemaVersion','Versión de diseño no admitida')
  check(schemaManifest.purposes.includes(design.purpose),'purpose','Tipo de documento no admitido')
  keys(design.paper,['format','margin'],'paper')
  check(Object.hasOwn(PAPER,design.paper.format),'paper.format','Formato de hoja no admitido')
  const maxMargin=design.paper.format==='RECEIPT_80'?20:60
  check(Number.isFinite(design.paper.margin)&&design.paper.margin>=8&&design.paper.margin<=maxMargin,'paper.margin',`Margen permitido: 8–${maxMargin} puntos`)
  keys(design.base,['id','version'],'base')
  check(schemaManifest.bases.includes(design.base.id)&&schemaManifest.baseVersions.includes(design.base.version),'base','Base o versión no admitida')
  validateTheme(design.themeOverrides)
  check(Array.isArray(design.blocks)&&design.blocks.length<=8,'blocks','Usa los bloques admitidos una sola vez')
  const seen=new Set(),kinds=new Set(); let previous=-1
  for(const [i,b] of design.blocks.entries()) {
    const path=`blocks[${i}]`; keys(b,['id','kind','settings','when'],path)
    check(typeof b.id==='string'&&/^[a-z][a-z0-9_-]{0,47}$/i.test(b.id)&&!seen.has(b.id),`${path}.id`,'Identificador inválido o repetido'); seen.add(b.id)
    check(Object.hasOwn(BLOCKS,b.kind)&&!kinds.has(b.kind),`${path}.kind`,'Bloque desconocido o repetido'); kinds.add(b.kind)
    const position=Object.keys(BLOCKS).indexOf(b.kind)
    check(position>previous,path,'Conserva el orden de los bloques protegidos'); previous=position
    if(b.when!==undefined) {
      check(schemaManifest.conditions.includes(b.when),`${path}.when`,'Condición no admitida')
      check(b.kind==='NOTES'||b.when==='ALWAYS',`${path}.when`,'Los bloques protegidos siempre deben mostrarse')
    }
    const rules=BLOCKS[b.kind].settings; keys(b.settings,Object.keys(rules),`${path}.settings`)
    for(const [key,value] of Object.entries(b.settings)) {
      const rule=rules[key],p=`${path}.settings.${key}`
      if(rule==='text')check(typeof value==='string'&&value.length<=2000&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value),p,'Texto inválido o demasiado largo (máximo 2000 caracteres)')
      else if(rule==='boolean')check(typeof value==='boolean',p,'Usa verdadero o falso')
      else if(rule==='images')check(Array.isArray(value)&&value.length<=5&&new Set(value).size===value.length&&value.every(x=>/^imagen-[1-5]$/.test(x)),p,'Usa hasta cinco espacios imagen-1 a imagen-5, sin URLs ni rutas')
      else if(rule==='columns'){
        const required=design.base.version===1?['description','quantity','unit','price','total']:['description','quantity','price','total'],allowed=design.base.version===1?required:schemaManifest.columns
        check(Array.isArray(value)&&value.length>=required.length&&value.length<=allowed.length&&new Set(value).size===value.length&&value.every(x=>allowed.includes(x))&&required.every(x=>value.includes(x)),p,'Incluye descripción, cantidad, precio e importe, sin columnas repetidas ni desconocidas')
      }
      else if(rule==='columnStyles'){
        check(design.base.version===2&&design.paper.format!=='RECEIPT_80',p,'Las opciones de columnas requieren base-version 2 y hoja Carta/A4; el ticket tiene distribución propia')
        check(Array.isArray(b.settings.columns),p,'Define las columnas antes de personalizar su estilo')
        keys(value,b.settings.columns,p)
        for(const [column,style] of Object.entries(value)){
          const s=`${p}.${column}`;keys(style,['label','width','align','when'],s)
          if(style.label!==undefined)check(typeof style.label==='string'&&style.label.trim().length>0&&style.label.length<=80&&!/[\u0000-\u001f]/.test(style.label),`${s}.label`,'Usa un título de columna de 1 a 80 caracteres')
          if(style.width!==undefined)check(Number.isFinite(style.width)&&style.width>=4&&style.width<=80,`${s}.width`,'El ancho debe estar entre 4 y 80 por ciento')
          if(style.align!==undefined)check(['left','center','right'].includes(style.align),`${s}.align`,'Alineación permitida: left, center o right')
          if(style.when!==undefined)check(style.when==='ALWAYS'||column==='discount'&&style.when==='HAS_DISCOUNT',`${s}.when`,'Solo la columna descuento puede ocultarse cuando no hay descuento')
        }
        const widths=Object.values(value).filter(s=>s.width!==undefined)
        if(widths.length)check(Array.isArray(b.settings.columns)&&widths.length===b.settings.columns.length&&Math.abs(widths.reduce((sum,s)=>sum+s.width,0)-100)<.01,p,'Indica el ancho de todas las columnas y haz que sumen 100 por ciento')
      }
      else check(rule.includes(value),p,'Valor no admitido')
    }
  }
  for(const [kind,rule] of Object.entries(BLOCKS))if(rule.required||kind==='FISCAL'&&design.purpose==='FEL_INVOICE')check(kinds.has(kind),'blocks',`Falta el bloque protegido ${kind}`)
  const normalized=JSON.parse(JSON.stringify(design))
  const styles=normalized.blocks.find(b=>b.kind==='DETAILS')?.settings.columnStyles
  if(styles){for(const key of Object.keys(styles))if(!Object.keys(styles[key]).length)delete styles[key];if(!Object.keys(styles).length)delete normalized.blocks.find(b=>b.kind==='DETAILS').settings.columnStyles}
  return normalized
}
function validateAppearance(value) {
  keys(value,Object.keys(schemaManifest.appearance),'appearance')
  const theme=Object.fromEntries(Object.entries(value).filter(([k])=>Object.hasOwn(THEME,k)))
  validateTheme(theme)
  for(const key of ['headerText','footerText'])if(Object.hasOwn(value,key))check(typeof value[key]==='string'&&value[key].length<=2000&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value[key]),`appearance.${key}`,'Usa texto de hasta 2000 caracteres')
  if(value.preferredFormat)check(['LETTER','A4'].includes(value.preferredFormat),'appearance.preferredFormat','Elige Carta o A4 como hoja preferida')
  return theme
}
function stable(value) {
  if(Array.isArray(value))return `[${value.map(stable).join(',')}]`
  if(value&&typeof value==='object')return `{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`
  return JSON.stringify(value)
}
function hash(value){return crypto.createHash('sha256').update(stable(value)).digest('hex')}
module.exports={LIMITS,PAPER,BLOCKS,THEME,schemaManifest,invalid,check,validateDesign,validateTheme,validateAppearance,hash}
