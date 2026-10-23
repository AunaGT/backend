const {LIMITS,invalid,check}=require('./contract')
const ENTITIES={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"}
function location(source,offset=0){if(typeof source!=='string')return {line:1,column:1};const before=source.slice(0,offset);return {line:before.split('\n').length,column:offset-before.lastIndexOf('\n')}}
function parse(source){
  check(typeof source==='string'&&Buffer.byteLength(source)<=LIMITS.xmlBytes,'source','Usa XML UTF-8 de hasta 256 KiB')
  let i=0,nodes=0
  const fail=message=>{throw invalid('source',message,location(source,i))}
  const ws=()=>{while(i<source.length&&/\s/.test(source[i]))i++}
  const comment=()=>{const end=source.indexOf('-->',i+4);if(end<0)fail('Falta cerrar el comentario XML');const value=source.slice(i+4,end);if(value.includes('--')||value.endsWith('-'))fail('Comentario XML inválido');i=end+3}
  const trivia=()=>{ws();while(source.startsWith('<!--',i)){comment();ws()}}
  const name=()=>{const start=i;if(!/[a-zA-Z_]/.test(source[i]||''))fail('Se esperaba una etiqueta o atributo');while(i<source.length&&/[a-zA-Z0-9_.:-]/.test(source[i]))i++;if(i-start>64)fail('Nombre demasiado largo');return source.slice(start,i)}
  const decode=raw=>raw.replace(/&([^;]*);|&/g,(_full,key)=>{
    if(Object.hasOwn(ENTITIES,key))return ENTITIES[key]
    if(/^#(?:[0-9]{1,7}|x[0-9a-f]{1,6})$/i.test(key||'')){
      const cp=key[1].toLowerCase()==='x'?parseInt(key.slice(2),16):Number(key.slice(1))
      if([9,10,13].includes(cp)||cp>=32&&cp<=0x10ffff&&!(cp>=0xd800&&cp<=0xdfff)&&cp!==0xfffe&&cp!==0xffff)return String.fromCodePoint(cp)
    }
    fail('Entidad XML no admitida. Usa entidades estándar o un carácter Unicode válido')
  })
  const element=depth=>{
    const from=i
    if(depth>LIMITS.depth)fail('El XML supera la profundidad máxima de 12')
    if(++nodes>LIMITS.nodes)fail('El XML supera el límite de 200 nodos')
    if(source[i]!=='<')fail('Se esperaba una etiqueta; coloca el texto en un atributo text')
    i++;if(source[i]==='!'||source[i]==='?')fail('No se permiten DTD, entidades externas, CDATA ni instrucciones de procesamiento')
    const tag=name(),attrs=Object.create(null),locations=Object.create(null),children=[]
    for(;;){
      const start=i;ws();if(source[i]==='>'||source.startsWith('/>',i))break
      if(start===i)fail('Falta separar un atributo')
      const attrFrom=i,key=name();locations[key]=attrFrom;if(Object.hasOwn(attrs,key))fail(`Atributo repetido: ${key}`)
      ws();if(source[i++]!=='=')fail('El atributo requiere =');ws()
      const quote=source[i++];if(quote!=='"'&&quote!=="'")fail('Usa comillas en los atributos')
      const valueFrom=i;while(i<source.length&&source[i]!==quote){if(source[i]==='<')fail('Escapa < como &lt;');i++}
      if(i===source.length)fail('Faltan comillas de cierre')
      attrs[key]=decode(source.slice(valueFrom,i));i++
    }
    if(source.startsWith('/>',i)){i+=2;return {tag,attrs,children,from,locations}}
    i++
    for(;;){trivia();if(source.startsWith('</',i))break;if(i>=source.length)fail(`Falta cerrar ${tag}`);children.push(element(depth+1))}
    i+=2;const closing=name();ws();if(closing!==tag||source[i++]!=='>')fail(`Se esperaba </${tag}>`)
    return {tag,attrs,children,from,locations}
  }
  ws()
  if(source.startsWith('<?xml',i)){
    const declaration=/^<\?xml\s+version\s*=\s*(['"])1\.0\1(?:\s+encoding\s*=\s*(['"])UTF-8\2)?(?:\s+standalone\s*=\s*(['"])(?:yes|no)\3)?\s*\?>/i.exec(source.slice(i))
    if(!declaration)fail('Solo se admite la declaración XML 1.0 con codificación UTF-8, sin instrucciones externas')
    i+=declaration[0].length
  }
  trivia();const root=element(1);trivia();if(i!==source.length)fail('Contenido adicional después de la raíz')
  return root
}
module.exports={parse,location}
