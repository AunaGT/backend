const test=require('node:test')
const assert=require('node:assert/strict')
const fs=require('node:fs/promises')
const os=require('node:os')
const path=require('node:path')
const {execFileSync}=require('node:child_process')
const {renderDocument,freezeProfile,resolveBase}=require('../src/modules/config/documentTemplates/public')
const {sampleData}=require('./fixtures/documentTemplates/data')
async function textOf(buffer) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'auna-document-'))
  try {await fs.writeFile(path.join(dir,'test.pdf'),buffer);return execFileSync('pdftotext',['-layout',path.join(dir,'test.pdf'),'-'],{encoding:'utf8'})}
  finally {await fs.rm(dir,{recursive:true,force:true})}
}
test('PDF flow preserves exact quantities, all lines, totals and the internal notice in all nine bases',async()=>{
  for(const base of ['CLASSIC','COMPACT','CORPORATE']) for(const format of ['LETTER','A4','RECEIPT_80']) {
    const result=await renderDocument({data:sampleData(20),profile:freezeProfile(resolveBase(base,format)),assets:{}})
    assert.equal(result.buffer.subarray(0,5).toString(),'%PDF-')
    const text=await textOf(result.buffer)
    assert.match(text,/0\.123456\s+kg/);assert.match(text,/18\.90/)
    assert.equal((text.match(/Artículo \d+/g)||[]).length,20)
    assert.match(text,/No constituye\s+factura\s+fiscal/); assert.match(text,/María López/)
    assert.equal((text.replace(/\s+/g,' ').match(/No constituye factura fiscal/g)||[]).length,1)
    const lastPage=text.split('\f').filter(x=>x.trim()).at(-1)
    assert.match(lastPage,/TOTAL:/,'El cierre no debe quedar solo en una página huérfana')
    assert.equal(result.rendererVersion,'INVOICE_BLOCKS_V2')
  }
})
test('hundreds of rows paginate without losing the last row or duplicating any row',async()=>{
  const result=await renderDocument({data:sampleData(200),profile:freezeProfile(resolveBase('CLASSIC','A4')),assets:{}})
  assert.ok(result.pageCount>1)
  const text=await textOf(result.buffer)
  assert.equal((text.match(/Artículo \d+/g)||[]).length,200); assert.match(text,/Artículo 200/)
  assert.ok((text.match(/DESCRIPCIÓN/g)||[]).length>=result.pageCount-1)
})
test('every page of a long preview remains visibly marked as a non-fiscal sample',async()=>{
  const result=await renderDocument({data:sampleData(200),profile:freezeProfile(resolveBase('CLASSIC','A4')),assets:{},limits:{preview:true}})
  const pages=(await textOf(result.buffer)).split('\f').filter(p=>p.trim())
  assert.ok(pages.length>2)
  for(const page of pages)assert.match(page,/MUESTRA/)
})
test('a short 80mm receipt uses its content height instead of feeding a full A4-length sheet',async()=>{
  const result=await renderDocument({data:sampleData(1),profile:freezeProfile(resolveBase('CLASSIC','RECEIPT_80')),assets:{}})
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'auna-paper-'))
  try {
    await fs.writeFile(path.join(dir,'short.pdf'),result.buffer)
    const info=execFileSync('pdfinfo',[path.join(dir,'short.pdf')],{encoding:'utf8'}),size=/Page size:\s+([\d.]+) x ([\d.]+)/.exec(info)
    assert.ok(size);assert.ok(Math.abs(Number(size[1])-226.772)<.1);assert.ok(Number(size[2])<500)
    assert.match(await textOf(result.buffer),/No constituye\s+factura\s+fiscal/)
  }finally{await fs.rm(dir,{recursive:true,force:true})}
})
test('huge row, missing glyph, lost required resource and excessive output fail explicitly, never yield a partial PDF',async()=>{
  const profile=freezeProfile(resolveBase('CLASSIC','A4'))
  for(const [mutate,code] of [[d=>d.lines[0].name='Texto '.repeat(5000),'DOCUMENT_ROW_TOO_TALL'],[d=>d.lines[0].name='😀','DOCUMENT_GLYPH_UNSUPPORTED']]) {
    const data=sampleData();mutate(data)
    await assert.rejects(renderDocument({data,profile,assets:{}}),{code})
  }
  await assert.rejects(renderDocument({data:sampleData(),profile:{...profile,resourceRefs:[{id:'logo',required:true}]},assets:{}}),{code:'DOCUMENT_ASSET_MISSING'})
  await assert.rejects(renderDocument({data:sampleData(),profile,assets:{},limits:{pdfBytes:100}}),{code:'DOCUMENT_PDF_TOO_LARGE'})
})
test('preview and production page ceilings reject the first page over their limits',async()=>{
  const profile=freezeProfile(resolveBase('COMPACT','RECEIPT_80'))
  await assert.rejects(renderDocument({data:sampleData(2000),profile,assets:{},limits:{preview:true}}),{code:'DOCUMENT_PAGE_LIMIT'})
  await assert.rejects(renderDocument({data:sampleData(10000),profile,assets:{}}),{code:'DOCUMENT_PAGE_LIMIT'})
})
test('fiscal fixtures are clearly samples and unverified real fiscal data cannot be rendered',async()=>{
  const data=sampleData();data.purpose='FEL_INVOICE';data.fiscal={fixture:true,verificationText:'https://example.invalid/fel-demo'}
  const profile=freezeProfile(resolveBase('CLASSIC','A4','FEL_INVOICE'))
  const result=await renderDocument({data,profile,assets:{},limits:{preview:true}})
  assert.match(await textOf(result.buffer),/MUESTRA.*SIN VALIDEZ FISCAL/)
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'auna-qr-'))
  try {
    await fs.writeFile(path.join(dir,'sample.pdf'),result.buffer)
    execFileSync('pdftoppm',['-f','1','-singlefile','-scale-to','1800','-png',path.join(dir,'sample.pdf'),path.join(dir,'sample')])
    const decoded=execFileSync('zbarimg',['--quiet','--raw',path.join(dir,'sample.png')],{encoding:'utf8',stdio:['ignore','pipe','ignore']})
    assert.equal(decoded.trim(),'https://example.invalid/fel-demo')
  }finally{await fs.rm(dir,{recursive:true,force:true})}
  await assert.rejects(renderDocument({data,profile,assets:{}}),{code:'FISCAL_CONNECTOR_UNAVAILABLE'})
})
