const test=require('node:test'),assert=require('node:assert/strict'),{createHash}=require('node:crypto')
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),{execFileSync}=require('node:child_process')
const {resolveBase,freezeProfile,renderDocument}=require('../src/modules/config/documentTemplates/public')
const {sampleData}=require('./fixtures/documentTemplates/data')
async function inspect(buffer){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'auna-defaults-'));try{const file=path.join(dir,'sample.pdf');await fs.writeFile(file,buffer);return {text:execFileSync('/usr/bin/pdftotext',['-layout',file,'-'],{encoding:'utf8'}),bbox:execFileSync('/usr/bin/pdftotext',['-bbox',file,'-'],{encoding:'utf8'})}}finally{await fs.rm(dir,{recursive:true,force:true})}}
async function assertGrayscale(buffer){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'auna-gray-proof-'));try{const file=path.join(dir,'sample.pdf');await fs.writeFile(file,buffer);execFileSync('/usr/bin/pdftoppm',['-scale-to','800','-png',file,path.join(dir,'page')]);for(const name of await fs.readdir(dir)){if(!name.endsWith('.png'))continue;const {data,info}=await require('sharp')(path.join(dir,name)).removeAlpha().raw().toBuffer({resolveWithObject:true});for(let i=0;i<data.length;i+=info.channels)assert(data[i]===data[i+1]&&data[i]===data[i+2],'All page strokes and images must be grayscale')}}finally{await fs.rm(dir,{recursive:true,force:true})}}
test('legacy base 1 preserves the captured profile and exact PDF bytes',async()=>{
  const design=resolveBase('CLASSIC','LETTER','INTERNAL_RECEIPT',1),profile=freezeProfile(design)
  assert.equal(profile.designHash,'b73397d6b08cc5418141a6d9a8e68342379ae2ff0e2f4bb46db033a9e1d0e6a5')
  const pdf=await renderDocument({data:sampleData(),profile,assets:{}})
  assert.equal(createHash('sha256').update(pdf.buffer).digest('hex'),'32ecfda23216a72bc9147958bb33cc0209db1a1cbf209ebbb6a59ef0ad31670b')
})
test('new classic sheet lays issuer beside the document box and never fabricates fiscal fields',async()=>{
  const profile=freezeProfile(resolveBase('CLASSIC','LETTER')),pdf=await renderDocument({data:sampleData(),profile,assets:{}})
  assert.equal(pdf.rendererVersion,'INVOICE_BLOCKS_V2')
  const {text,bbox}=await inspect(pdf.buffer)
  const issuer=/<word[^>]*yMin="([\d.]+)"[^>]*>Café<\/word>/.exec(bbox),title=/<word[^>]*yMin="([\d.]+)"[^>]*>COMPROBANTE<\/word>/.exec(bbox)
  assert(issuer&&title);assert.ok(Math.abs(Number(issuer[1])-Number(title[1]))<24,'Issuer and title belong to the same horizontal header')
  const subtotal=/<word[^>]*xMin="([\d.]+)"[^>]*>Subtotal<\/word>/.exec(bbox);assert(subtotal);assert.ok(Number(subtotal[1])>300,'Sheet totals belong in the right summary column')
  assert.doesNotMatch(text,/FORMA DE PAGO|Recibido:|Cambio:/);assert.match(text,/No constituye\s+factura\s+fiscal/)
  assert.doesNotMatch(text,/Autorización|IVA 12|Certificador|DATOS FISCALES/)
})
test('80 mm default embeds the business logo and keeps quantity, price and total of each ticket line',async()=>{
  const sharp=require('sharp'),logo=await sharp({create:{width:40,height:30,channels:4,background:'#ff7015'}}).png().toBuffer()
  const profile=freezeProfile(resolveBase('CLASSIC','RECEIPT_80'),{},[{id:'company-logo',role:'logo',required:true,sourceUrl:'retained-logo'}])
  const data=sampleData(3);data.saleReference='MUESTRA-0001'
  const pdf=await renderDocument({data,profile,assets:{'company-logo':logo}}),{text}=await inspect(pdf.buffer)
  assert(pdf.buffer.includes(Buffer.from('/Subtype /Image')))
  assert.match(text,/CANT/);assert.match(text,/TOTAL/);assert.match(text.replace(/\s+/g,' '),/0\.123456 kg x Q 18\.90/)
  assert.equal((text.match(/Artículo \d+/g)||[]).length,3);assert.match(text,/Q 2\.33/)
  assert.equal(profile.design.base.version,2);assert.equal(profile.resolvedTheme.textColor,'#000000');assert.equal(profile.resolvedTheme.fontFamily,'Courier')
  assert.match(text,/MUESTRA-0001/)
  assert.match(text.replace(/\s+/g,' '),/Descuento Q 0\.00/)
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'auna-monochrome-'))
  try{const file=path.join(dir,'ticket.pdf');await fs.writeFile(file,pdf.buffer);execFileSync('/usr/bin/pdftoppm',['-singlefile','-scale-to','600','-png',file,path.join(dir,'ticket')]);const {data,info}=await sharp(path.join(dir,'ticket.png')).removeAlpha().raw().toBuffer({resolveWithObject:true});for(let i=0;i<data.length;i+=info.channels)assert(data[i]===data[i+1]&&data[i]===data[i+2],'Every rendered ticket pixel, including the business logo, must be grayscale')}finally{await fs.rm(dir,{recursive:true,force:true})}
})
test('classic FEL is a sample-only layout with protected pending certification',async()=>{
  const data=require('../src/modules/config/documentTemplates/previews').scenarioData('SHORT','FEL_INVOICE')
  data.paymentAtPreparation={method:'Efectivo',received:'100.00',change:'10.00'}
  const profile=freezeProfile(resolveBase('CLASSIC','LETTER','FEL_INVOICE'))
  const pdf=await renderDocument({data,profile,assets:{},limits:{preview:true}}),{text}=await inspect(pdf.buffer)
  assert.equal(pdf.pageCount,1);assert.doesNotMatch(text,/Recibido:|Cambio:|FORMA DE PAGO/)
  assert.match(text,/FACTURA/);assert.match(text,/Serie/);assert.match(text,/Autorización/);assert.match(text,/MUESTRA/)
  await assert.rejects(renderDocument({data,profile,assets:{}}),{code:'FISCAL_CONNECTOR_UNAVAILABLE'})
  assert.equal(profile.resolvedTheme.accentColor,'#000000');assert.deepEqual(profile.design.blocks.find(b=>b.kind==='DETAILS').settings.columns,['number','quantity','description','price','discount','total'])
})
test('classic Carta has no colored borders, separators or images',async()=>{
  const profile=freezeProfile(resolveBase('CLASSIC','LETTER')),pdf=await renderDocument({data:sampleData(),profile,assets:{},limits:{preview:true}})
  await assertGrayscale(pdf.buffer)
})
test('ticket thanks is the final printed line, after sample/fiscal notices and QR certification',async()=>{
  for(const purpose of ['INTERNAL_RECEIPT','FEL_INVOICE']){
    const data=require('../src/modules/config/documentTemplates/previews').scenarioData('SHORT',purpose)
    const pdf=await renderDocument({data,profile:freezeProfile(resolveBase('CLASSIC','RECEIPT_80',purpose)),assets:{},limits:{preview:true}}),{text}=await inspect(pdf.buffer)
    assert.match(text.trim(),/¡Gracias por su compra!\s*$/)
    if(purpose==='FEL_INVOICE'){
      const flat=text.replace(/\s+/g,' ')
      assert.ok(flat.indexOf('DOCUMENTO TRIBUTARIO ELECTRÓNICO')<flat.indexOf('FACTURA'))
      assert.ok(flat.indexOf('Autorización:')<flat.indexOf('Fecha'))
      assert.ok(text.indexOf('Certificador:')<text.indexOf('¡Gracias por su compra!'))
    }
  }
})
test('the approved Carta remains byte-identical after receipt footer changes',async()=>{
  const data=require('../src/modules/config/documentTemplates/previews').scenarioData('SHORT','FEL_INVOICE');data.paymentAtPreparation={method:'Efectivo',received:'100.00',change:'10.00'}
  const pdf=await renderDocument({data,profile:freezeProfile(resolveBase('CLASSIC','LETTER','FEL_INVOICE')),assets:{},limits:{preview:true}})
  assert.equal(createHash('sha256').update(pdf.buffer).digest('hex'),'50d57053442307134acc4ad30e0b223d26d01349a3fa9bcae05fcb512d046cd6')
})
