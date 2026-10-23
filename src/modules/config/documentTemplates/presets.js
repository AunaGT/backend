const {validateDesign,validateTheme,validateAppearance,hash}=require('./contract')
const DEFAULT_THEME=Object.freeze({fontFamily:'Helvetica',fontSize:10,accentColor:'#194f78',textColor:'#202a35',spacing:6})
const AUNA_THEME=Object.freeze({...DEFAULT_THEME,accentColor:'#000000',textColor:'#000000',spacing:4})
function resolveBase(id='CLASSIC',format='LETTER',purpose='INTERNAL_RECEIPT',version=2) {
  return validateDesign({schemaVersion:1,purpose,paper:{format,margin:format==='RECEIPT_80'?12:36},base:{id,version},themeOverrides:version===2&&id==='CLASSIC'?{accentColor:'#000000',textColor:'#000000',...(format==='RECEIPT_80'?{fontFamily:'Courier',fontSize:9,spacing:2}:{})}:{},blocks:[
    {id:'header',kind:'HEADER',settings:{showLogo:true,alignment:version===1?(id==='CLASSIC'?'center':'left'):(format==='RECEIPT_80'?'center':'left')}},
    {id:'emitter',kind:'EMITTER',settings:{}},{id:'receiver',kind:'RECEIVER',settings:{}},
    {id:'details',kind:'DETAILS',settings:{columns:version===2&&format!=='RECEIPT_80'&&id==='CLASSIC'?['number','quantity','description','price','discount','total']:['description','quantity','unit','price','total']}},
    {id:'totals',kind:'TOTALS',settings:{}},{id:'notes',kind:'NOTES',settings:{text:''},when:'HAS_NOTE'},
    ...(purpose==='FEL_INVOICE'?[{id:'fiscal',kind:'FISCAL',settings:{}}]:[]),
    {id:'footer',kind:'FOOTER',settings:{}},
  ]})
}
function freezeProfile(design,appearance={},resourceRefs=[],templateVersionId=null,withFallback=true) {
  design=validateDesign(design)
  const appearanceTheme=validateAppearance(appearance)
  const header=design.blocks.find(b=>b.kind==='HEADER'),footer=design.blocks.find(b=>b.kind==='FOOTER')
  if(header.settings.title===undefined)header.settings.title=appearance.headerText??(design.base.version===2&&design.purpose==='FEL_INVOICE'?'FACTURA':'Comprobante interno')
  if(footer.settings.text===undefined)footer.settings.text=appearance.footerText??(design.base.version===2?'¡Gracias por su compra!':'Gracias por tu compra.')
  const variant=design.base.id==='COMPACT'?{fontSize:9,spacing:3}:design.base.id==='CORPORATE'?{fontFamily:'Montserrat',...(design.base.version===1?{accentColor:'#842c13'}:{})}:{}
  const resolvedTheme={...(design.base.version===1?DEFAULT_THEME:AUNA_THEME),...variant,...appearanceTheme,...design.themeOverrides}; validateTheme(resolvedTheme)
  const profile={format:design.paper.format,templateVersionId,design,resolvedTheme,resourceRefs:JSON.parse(JSON.stringify(resourceRefs)),rendererVersion:design.base.version===1?'INVOICE_BLOCKS_V1':'INVOICE_BLOCKS_V2'}
  profile.designHash=hash(profile)
  profile.fallbackProfile=withFallback?freezeProfile(resolveBase('CLASSIC',design.paper.format,design.purpose,design.base.version),appearance,resourceRefs.filter(r=>r.role==='logo'),null,false):null
  return profile
}
module.exports={DEFAULT_THEME,resolveBase,freezeProfile}
