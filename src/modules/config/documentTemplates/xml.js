const {BLOCKS,THEME,invalid,check,validateDesign}=require('./contract')
const {parse,location}=require('./xmlParser')
const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]))
const COLUMN_ALIASES={linea:'number',numero:'number',cantidad:'quantity',descripcion:'description',unidad:'unit',precio:'price',descuento:'discount',total:'total'}
function fromXml(source){
  let root;const positions=new Map()
  const at=(node,attribute)=>node?.locations?.[attribute]??node?.from??0
  const fail=(node,message,attribute)=>{throw invalid(attribute?`<${node.tag}>.${attribute}`:`<${node.tag}>`,message,location(source,at(node,attribute)))}
  function attrs(node,allowed,aliases={}){
    const values=Object.create(null),offsets=Object.create(null)
    for(const [raw,value] of Object.entries(node.attrs)){
      const key=Object.hasOwn(aliases,raw)?aliases[raw]:raw
      if(!allowed.includes(key))fail(node,`Atributo no admitido: ${raw}`,raw)
      if(Object.hasOwn(values,key))fail(node,`No repitas ${key} usando dos nombres distintos`,raw)
      values[key]=value;offsets[key]=node.locations[raw]
    }
    node.locations={...node.locations,...offsets};return values
  }
  const leaf=node=>{if(node.children.length)fail(node.children[0],`La etiqueta ${node.tag} no admite ese contenido`)}
  try{
    root=parse(source)
    if(root.tag!=='plantilla-factura')fail(root,root.tag==='t'||root.tag==='templates'?'QWeb de Odoo no es XML de diseño Auna':root.tag.includes(':')?'XML fiscal no es una plantilla de diseño':'Usa <plantilla-factura version="1">')
    const a=attrs(root,['version','purpose','format','base','base-version','margin'],{formato:'format'}),format=a.format??'LETTER'
    const design={schemaVersion:Number(a.version),purpose:a.purpose??(root.children.some(n=>n.tag==='bloque'&&(n.attrs.kind||n.attrs.tipo)==='FISCAL')?'FEL_INVOICE':'INTERNAL_RECEIPT'),paper:{format,margin:Number(a.margin??(format==='RECEIPT_80'?12:36))},base:{id:a.base??'CLASSIC',version:Number(a['base-version']??2)},themeOverrides:{},blocks:[]}
    let themeSeen=false
    for(const node of root.children){
      if(node.tag==='tema'){
        leaf(node);if(themeSeen)fail(node,'El tema no se puede repetir');themeSeen=true
        for(const [k,v] of Object.entries(attrs(node,Object.keys(THEME)))){design.themeOverrides[k]=typeof THEME[k][0]==='number'?Number(v):v;positions.set(`themeOverrides.${k}`,at(node,k))}
        continue
      }
      if(node.tag!=='bloque')fail(node,`Etiqueta no admitida: ${node.tag}`)
      const kind=node.attrs.kind||node.attrs.tipo
      if(!Object.hasOwn(BLOCKS,kind))fail(node,'Tipo de bloque no admitido',node.attrs.tipo?'tipo':'kind')
      const rules=BLOCKS[kind].settings,b=attrs(node,['id','kind','when',...Object.keys(rules)],{tipo:'kind',condicion:'when'})
      const index=design.blocks.length,path=`blocks[${index}]`,settings={},put=(key,value,origin,attribute=key)=>{
        if(Object.hasOwn(settings,key))fail(origin,`La opción ${key} está repetida`,attribute)
        settings[key]=value;positions.set(`${path}.settings.${key}`,at(origin,attribute))
      }
      const setting=(key,value,origin)=>{
        const rule=rules[key]
        if(rule==='boolean'){if(!['true','false'].includes(value))fail(origin,'Usa true o false',key);value=value==='true'}
        if(rule==='columns'||rule==='images')value=value?value.split(',').map(v=>v.trim()):[]
        if(rule==='columnStyles')fail(origin,'Configura estilos usando etiquetas <column> dentro de <columns>',key)
        put(key,value,origin)
      }
      for(const [k,v] of Object.entries(b))if(!['id','kind','when'].includes(k))setting(k,v,node)
      let optionsSeen=false;const columns=[],styles={};let columnsSeen=false
      function column(child){
        if(kind!=='DETAILS')fail(child,'Las columnas pertenecen al bloque DETAILS')
        leaf(child);const c=attrs(child,['key','label','width','align','when'],{condicion:'when'}),key=COLUMN_ALIASES[c.key]||c.key
        if(!['number','quantity','description','unit','price','discount','total'].includes(key))fail(child,'Columna desconocida','key')
        if(columns.includes(key))fail(child,'Columna repetida','key')
        columns.push(key);styles[key]={}
        for(const name of ['label','width','align','when'])if(c[name]!==undefined){styles[key][name]=name==='width'?Number(c[name]):c[name];positions.set(`${path}.settings.columnStyles.${key}.${name}`,at(child,name))}
      }
      function children(parent){
        for(const child of parent.children){
          if(child.tag==='opciones'){
            if(parent!==node||optionsSeen)fail(child,'Usa un único apartado opciones por bloque');optionsSeen=true
            for(const [k,v] of Object.entries(attrs(child,Object.keys(rules))))setting(k,v,child)
            children(child)
          }else if(child.tag==='columns'){
            if(kind!=='DETAILS'||columnsSeen)fail(child,'Usa una sola lista de columnas en DETAILS')
            attrs(child,[]);columnsSeen=true
            for(const c of child.children){if(c.tag!=='column')fail(c,'Solo se admiten etiquetas column dentro de columns');column(c)}
          }else if(child.tag==='column')column(child)
          else if(child.tag==='images'){
            if(!['HEADER','FOOTER'].includes(kind))fail(child,'Las imágenes pertenecen a HEADER o FOOTER')
            attrs(child,[]);const slots=child.children.map(image=>{if(image.tag!=='image')fail(image,'Usa <image slot="imagen-1"/>');leaf(image);return attrs(image,['slot']).slot})
            put('images',slots,child)
          }else fail(child,`Etiqueta no admitida: ${child.tag}`)
        }
      }
      children(node)
      if(columnsSeen||columns.length){put('columns',columns,node);if(Object.values(styles).some(s=>Object.keys(s).length))put('columnStyles',styles,node)}
      positions.set(path,node.from);positions.set(`${path}.id`,at(node,'id'));positions.set(`${path}.kind`,at(node,'kind'));positions.set(`${path}.when`,at(node,'when'))
      design.blocks.push({id:b.id||kind.toLowerCase(),kind,settings,...(b.when?{when:b.when}:{})})
    }
    return validateDesign(design)
  }catch(error){
    if(error.code!=='TEMPLATE_INVALID')throw invalid('source','XML inválido',{line:1,column:1})
    error.diagnostics=error.diagnostics.map(d=>{
      if(d.line)return d
      const match=[...positions.keys()].filter(p=>d.path===p||d.path.startsWith(p+'.')).sort((a,b)=>b.length-a.length)[0]
      const rootAttr=({'paper.format':'format','paper.margin':'margin',schemaVersion:'version',purpose:'purpose',base:'base'})[d.path]
      return {...d,...location(source,match?positions.get(match):at(root,rootAttr))}
    });throw error
  }
}
function toXml(d){
  const attributes=obj=>Object.entries(obj).map(([k,v])=>` ${k}="${escape(Array.isArray(v)?v.join(','):v)}"`).join('')
  return `<plantilla-factura${attributes({version:1,purpose:d.purpose,format:d.paper.format,base:d.base.id,'base-version':d.base.version,margin:d.paper.margin})}>\n`+
    `  <tema${attributes(d.themeOverrides)}/>\n`+d.blocks.map(b=>{
      const {columnStyles,...settings}=b.settings,base={id:b.id,kind:b.kind,...(b.when?{when:b.when}:{})}
      if(!columnStyles)return `  <bloque${attributes({...base,...settings})}/>`
      const {columns,...other}=settings
      return `  <bloque${attributes({...base,...other})}>\n    <columns>\n`+columns.map(key=>`      <column${attributes({key,...columnStyles[key]})}/>`).join('\n')+'\n    </columns>\n  </bloque>'
    }).join('\n')+'\n</plantilla-factura>'
}
function compileTemplate(input){
  check(input&&Object.keys(input).length===1&&['source','design'].includes(Object.keys(input)[0]),'input','Envía source o design, no ambos')
  const design=Object.hasOwn(input,'source')?fromXml(input.source):validateDesign(input.design)
  return {schemaVersion:1,design,source:toXml(design)}
}
module.exports={compileTemplate}
