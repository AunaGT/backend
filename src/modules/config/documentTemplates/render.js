const PDFDocument=require('pdfkit')
const bwip=require('bwip-js')
const path=require('node:path')
const {PAPER,LIMITS,validateDesign,validateTheme}=require('./contract')
const {createFlow,documentError}=require('./layout')

function assertGlyphs(doc,font,text) {
  doc.font(font)
  const face=doc._font.font
  for(const char of text) {
    const code=char.codePointAt(0)
    if(code===9||code===10||code===13)continue
    const supported=face.hasGlyphForCodePoint?face.hasGlyphForCodePoint(code):face.characterToGlyph(code)!=='.notdef'
    if(!supported)throw documentError('DOCUMENT_GLYPH_UNSUPPORTED',`La fuente elegida no incluye el carácter U+${code.toString(16).toUpperCase()}`)
  }
}
function dataText(data,design) {
  const text=[]
  const walk=v=>{if(typeof v==='string')text.push(v);else if(Array.isArray(v))v.forEach(walk);else if(v&&typeof v==='object')Object.values(v).forEach(walk)}
  walk(data);walk(design.blocks.map(b=>b.settings))
  return text.join('\n')
}
async function renderPass({data,profile,assets={},limits={}},{pageHeights,sharedDeadline}={}) {
  const design=validateDesign(profile.design),theme=validateTheme(profile.resolvedTheme)
  const ticket=design.paper.format==='RECEIPT_80',reference=design.base.version===2,monochrome=reference&&theme.textColor==='#000000'&&theme.accentColor==='#000000'
  const preview=limits.preview===true,deadline=sharedDeadline||Date.now()+Math.min(limits.timeoutMs??(preview?10000:30000),preview?10000:30000)
  if(data.purpose!==design.purpose)throw documentError('DOCUMENT_PURPOSE_MISMATCH','El diseño y el documento deben ser del mismo tipo')
  if(data.purpose==='FEL_INVOICE'&&(!preview||data.fiscal?.fixture!==true))throw documentError('FISCAL_CONNECTOR_UNAVAILABLE','El certificador fiscal aún no está conectado')
  if(Buffer.byteLength(JSON.stringify({data,profile}))>LIMITS.snapshotBytes)throw documentError('DOCUMENT_DATA_TOO_LARGE','El documento supera 2 MiB de datos')
  const refs=profile.resourceRefs||[]
  if(refs.length>5||Object.values(assets).reduce((n,b)=>n+(Buffer.isBuffer(b)?b.length:0),0)>LIMITS.resourceBytes)throw documentError('DOCUMENT_ASSET_LIMIT','Los recursos exceden los límites del documento')
  for(const ref of refs)if(ref.required&&!Buffer.isBuffer(assets[ref.id]))throw documentError('DOCUMENT_ASSET_MISSING','No se pudo recuperar un recurso original del documento')
  if(monochrome){const entries=[];for(const [key,buffer] of Object.entries(assets)){try{entries.push([key,await require('sharp')(buffer,{limitInputPixels:20000000}).flatten({background:'#ffffff'}).greyscale().png().toBuffer()])}catch{throw documentError('DOCUMENT_ASSET_INVALID','No se pudo preparar una imagen para impresión en blanco y negro')}}assets=Object.fromEntries(entries)}
  const doc=new PDFDocument({autoFirstPage:false,bufferPages:true,compress:true,info:{Title:'Comprobante interno',CreationDate:new Date(data.issuedAt),ModDate:new Date(data.issuedAt)}})
  let font=theme.fontFamily==='Courier'?'Courier':'Helvetica',fontBold=theme.fontFamily==='Courier'?'Courier-Bold':'Helvetica-Bold'
  if(theme.fontFamily==='Montserrat') {
    for(const [name,file] of [['Montserrat','Montserrat-Regular.ttf'],['Montserrat-Bold','Montserrat-Bold.ttf'],['Montserrat-Italic','Montserrat-Italic.ttf'],['Montserrat-BoldItalic','Montserrat-BoldItalic.ttf']])doc.registerFont(name,path.join(__dirname,'../../../../assets/fonts/invoices',file))
    font='Montserrat';fontBold='Montserrat-Bold'
  }
  assertGlyphs(doc,font,dataText(data,design));assertGlyphs(doc,fontBold,dataText(data,design))
  const maxBytes=Math.min(limits.pdfBytes??LIMITS.pdfBytes,LIMITS.pdfBytes)
  const chunks=[];let bytes=0
  const output=new Promise((resolve,reject)=>{
    doc.on('data',chunk=>{bytes+=chunk.length;if(bytes>maxBytes){reject(documentError('DOCUMENT_PDF_TOO_LARGE','El PDF excede el tamaño permitido'));doc.destroy()}else chunks.push(chunk)})
    doc.on('end',()=>resolve(Buffer.concat(chunks)));doc.on('error',reject)
  })
  // Attach rejection handler before synchronous layout can throw and destroy the stream.
  output.catch(()=>{})
  try {
    const size=PAPER[design.paper.format];let fiscalFooter=null
    const flow=createFlow(doc,{...size,margin:design.paper.margin,font,fontBold,fontSize:theme.fontSize,color:theme.textColor,accent:theme.accentColor,spacing:theme.spacing,maxPages:Math.min(limits.maxPages??(preview?20:100),preview?20:100),deadline,preview,pageHeights,thermal:reference&&ticket,monochrome})
    if(preview)flow.text('MUESTRA · SIN VALIDEZ FISCAL',{bold:true,size:ticket?9:12,color:theme.accentColor})
    for(const block of design.blocks) {
      if(block.when==='HAS_NOTE'&&!block.settings.text)continue
      if(block.when==='HAS_DISCOUNT'&&!Number(data.totals.discount))continue
      for(const slot of block.settings.images||[]) {
        if(!assets[slot])throw documentError('DOCUMENT_ASSET_MISSING',`Asocia la imagen del espacio ${slot}`)
        flow.image(assets[slot],48)
      }
      switch(block.kind) {
        case 'HEADER': {
          const logo=refs.find(r=>r.role==='logo')
          if(reference&&!ticket){flow.letterHeader(data,(block.settings.title||'Comprobante interno').toUpperCase(),block.settings.showLogo&&logo?assets[logo.id]:null);break}
          if(block.settings.showLogo&&logo&&assets[logo.id])flow.image(assets[logo.id],48,block.settings.alignment)
          if(reference){flow.text(data.emitter.name,{bold:true,size:theme.fontSize*1.25,align:'center',color:theme.textColor});break}
          flow.text(block.settings.title||'Comprobante interno',{bold:true,size:ticket?13:18,align:block.settings.alignment,color:theme.accentColor})
          flow.text(`${data.saleReference} · ${data.issuedAt.slice(0,10)}`,{align:block.settings.alignment});break
        }
        case 'EMITTER':
          if(reference){
            if(!ticket)break
            for(const value of [data.emitter.nit&&`NIT: ${data.emitter.nit}`,data.emitter.address,data.emitter.branch].filter(Boolean))flow.text(value,{align:'center',gap:3})
            flow.rule()
            if(data.purpose==='FEL_INVOICE')flow.text('DOCUMENTO TRIBUTARIO ELECTRÓNICO',{bold:true,align:'center'})
            flow.text(design.blocks.find(b=>b.kind==='HEADER').settings.title.toUpperCase(),{bold:true,align:'center',color:theme.accentColor})
            if(data.purpose==='FEL_INVOICE'){flow.pair('Serie',data.fiscal.series||'MUESTRA',{labelRatio:.35});flow.pair('No. DTE',data.fiscal.number||'MUESTRA',{labelRatio:.35});flow.text(`Autorización: ${data.fiscal.authorization||'MUESTRA · PENDIENTE DE CERTIFICACIÓN'}`,{size:8})}
            else flow.pair('Referencia',data.saleReference,{labelRatio:.35})
            flow.pair('Fecha',data.issuedAt.slice(0,10),{labelRatio:.35})
            flow.rule();break
          }
          flow.text(data.emitter.name,{bold:true});flow.text([data.emitter.nit&&`NIT: ${data.emitter.nit}`,data.emitter.address,data.emitter.branch].filter(Boolean).join(' · '));flow.rule();break
        case 'RECEIVER':if(reference){if(!ticket)flow.receiverBox(data.receiver,data.totals.currency);else{flow.text(`NIT: ${data.receiver.nit||'CF'}`);flow.text(`Nombre: ${data.receiver.name}`);flow.rule()}break}flow.text(`Cliente: ${data.receiver.name}`);flow.text(`NIT: ${data.receiver.nit||'CF'}`);flow.rule();break
        case 'DETAILS':flow.table(data.lines,block.settings.columns||['description','quantity','unit','price','total'],ticket,reference,data.totals.currency,block.settings.columnStyles,Number(data.totals.discount)>0||data.lines.some(line=>Number(line.discount)>0));break
        case 'TOTALS': {
          const rows=[`Subtotal: ${data.totals.currency} ${data.totals.subtotal}`,...(Number(data.totals.discount)||reference&&ticket?[`Descuento: ${data.totals.currency} ${data.totals.discount}`]:[]),`TOTAL: ${data.totals.currency} ${data.totals.total}`]
          let closingHeight=rows.reduce((h,t,i)=>h+flow.measure(t,undefined,theme.fontSize+(i===rows.length-1?2:0),true)+theme.spacing,0)+12
          if(reference&&ticket&&data.paymentAtPreparation?.method)closingHeight+=flow.measure(data.paymentAtPreparation.method,undefined,theme.fontSize)+theme.spacing+30
          if(reference&&ticket)for(const field of ['received','change'])if(data.paymentAtPreparation?.[field]!=null)closingHeight+=flow.measure(`${data.totals.currency} ${data.paymentAtPreparation[field]}`)+theme.spacing+12
          for(const tail of design.blocks.slice(design.blocks.indexOf(block)+1)) {
            closingHeight+=(tail.settings.images||[]).length*(48+theme.spacing)
            if(tail.kind==='FISCAL')closingHeight+=reference&&!ticket?92:flow.measure('DATOS FISCALES FICTICIOS — SOLO DEMOSTRACIÓN',undefined,theme.fontSize,true)+80+theme.spacing+(reference?60:0)
            if(tail.settings.text)closingHeight+=flow.measure(tail.settings.text)+theme.spacing
            if(tail.kind==='FOOTER') {
              for(const notice of data.notices||[])if(notice!=='Comprobante interno. No constituye factura fiscal.'&&notice!=='MUESTRA · SIN VALIDEZ FISCAL')closingHeight+=flow.measure(notice)+theme.spacing
              closingHeight+=flow.measure(preview?'MUESTRA · SIN VALIDEZ FISCAL':'Comprobante interno. No constituye factura fiscal.',undefined,theme.fontSize,true)+theme.spacing
            }
          }
          flow.ensure(closingHeight)
          if(reference){
            flow.rule();flow.pair('Subtotal',`${data.totals.currency} ${data.totals.subtotal}`,{summary:!ticket,labelRatio:.4});if(ticket||Number(data.totals.discount))flow.pair('Descuento',`${data.totals.currency} ${data.totals.discount}`,{summary:!ticket,labelRatio:.4})
            flow.pair('TOTAL:',`${data.totals.currency} ${data.totals.total}`,{bold:true,size:theme.fontSize+2,total:true,summary:!ticket,labelRatio:.4})
            if(ticket&&data.paymentAtPreparation?.method){flow.rule();flow.pair('Forma de pago:',data.paymentAtPreparation.method,{size:9})}
            if(ticket)for(const [field,label] of [['received','Recibido:'],['change','Cambio:']])if(data.paymentAtPreparation?.[field]!=null)flow.pair(label,`${data.totals.currency} ${data.paymentAtPreparation[field]}`,{size:9});break
          }
          flow.rule();rows.forEach((r,i)=>flow.text(r,{bold:true,align:'right',size:i===rows.length-1?theme.fontSize+2:theme.fontSize}));break
        }
        case 'NOTES':flow.text(block.settings.text);break
        case 'FISCAL': {
          if(reference&&!ticket){fiscalFooter=await bwip.toBuffer({bcid:'qrcode',text:data.fiscal.verificationText,scale:3,padding:2});break}
          if(reference&&ticket){
            const qr=await bwip.toBuffer({bcid:'qrcode',text:data.fiscal.verificationText,scale:3,padding:2})
            flow.rule();flow.image(qr,72,'center');flow.text('Certificador: datos ficticios de muestra',{align:'center',size:8});flow.text('Certificación: pendiente de conexión',{align:'center',size:8});break
          }
          flow.text('DATOS FISCALES FICTICIOS — SOLO DEMOSTRACIÓN',{bold:true})
          if(reference){flow.text('Pendiente de certificación · MUESTRA',{size:9});flow.text('Certificador: datos ficticios de prueba',{size:9})}
          const qr=await bwip.toBuffer({bcid:'qrcode',text:data.fiscal.verificationText,scale:3,padding:2})
          flow.image(qr,72,reference?'center':'left');break
        }
        case 'FOOTER':
          if(reference&&ticket){
            for(const notice of data.notices||[])if(notice!=='Comprobante interno. No constituye factura fiscal.'&&notice!=='MUESTRA · SIN VALIDEZ FISCAL')flow.text(notice,{align:'center',size:8})
            flow.text(preview?'MUESTRA · SIN VALIDEZ FISCAL':'Comprobante interno. No constituye factura fiscal.',{align:'center',size:8})
            flow.rule();flow.text(block.settings.text,{bold:true,align:'center'});break
          }
          flow.text(block.settings.text)
          for(const notice of data.notices||[])if(notice!=='Comprobante interno. No constituye factura fiscal.'&&notice!=='MUESTRA · SIN VALIDEZ FISCAL')flow.text(notice)
          // Mandatory system notice cannot be removed by a template or input payload.
          flow.text(preview?'MUESTRA · SIN VALIDEZ FISCAL':'Comprobante interno. No constituye factura fiscal.',{bold:true})
          if(fiscalFooter)flow.verification(fiscalFooter,['Datos del certificador: MUESTRA · pendiente de conexión','Fecha de certificación: MUESTRA, sin certificación real','Documento de demostración. Sin validez fiscal.'])
          break
      }
    }
    flow.finish();doc.end()
    return {buffer:await output,pageCount:flow.pageCount,pageHeights:flow.pageHeights,deadline,rendererVersion:reference?'INVOICE_BLOCKS_V2':'INVOICE_BLOCKS_V1'}
  }catch(error){doc.destroy();throw error}
}
async function renderDocument(input){
  let result=await renderPass(input)
  // Measure with the same flow before choosing physical roll lengths; never crop an already drawn page.
  if(input.profile.design.paper.format==='RECEIPT_80')result=await renderPass(input,{pageHeights:result.pageHeights,sharedDeadline:result.deadline})
  return {buffer:result.buffer,pageCount:result.pageCount,rendererVersion:result.rendererVersion}
}
module.exports={renderDocument}
