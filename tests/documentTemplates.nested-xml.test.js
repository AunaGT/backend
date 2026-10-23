const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path')
const {compileTemplate,resolveBase}=require('../src/modules/config/documentTemplates/public')
const fixture=v=>fs.readFileSync(path.join(__dirname,`fixtures/documentTemplates/clasico-fel-v${v}.xml`),'utf8')
for(const v of [1,2,3,4])test(`customer XML v${v} imports nested options/columns without losing its layout`,()=>{
  const result=compileTemplate({source:fixture(v)}),d=result.design
  assert.equal(d.purpose,'FEL_INVOICE');assert.equal(d.paper.format,'LETTER');assert.equal(d.paper.margin,36);assert.deepEqual(d.base,{id:'CLASSIC',version:2})
  assert.equal(d.blocks[0].settings.title,'FACTURA')
  const details=d.blocks.find(b=>b.kind==='DETAILS').settings
  assert.deepEqual(details.columns,['number','quantity','description','price','discount','total'])
  assert.deepEqual(details.columnStyles.description,{label:'Descripción',width:44,align:'left'})
  assert.deepEqual(details.columnStyles.discount,{label:'Descuento',width:12,align:'right',when:'HAS_DISCOUNT'})
  assert.deepEqual(compileTemplate({source:result.source}).design,d)
})
test('semantic child error identifies the offending column attribute, not root line 1',()=>{
  const source=fixture(2).replace('width="44"','width="0"'),lines=source.split('\n'),line=lines.findIndex(l=>l.includes('width="0"'))+1
  assert.throws(()=>compileTemplate({source}),e=>e.code==='TEMPLATE_INVALID'&&e.diagnostics[0].line===line&&e.diagnostics[0].column>1)
})
test('safe XML declaration, comments and numeric character references decode as data only',()=>{
  const source=compileTemplate({design:resolveBase()}).source.replace('<tema','<!-- note -->\n<tema').replace('kind="HEADER"','kind="HEADER" title="Caf&#233; &#x2615; &amp;lt;script&amp;gt;"')
  const d=compileTemplate({source:'\ufeff<?xml version="1.0" encoding="UTF-8"?>\n'+source+'\n<!-- end -->'}).design
  assert.equal(d.blocks[0].settings.title,'Café ☕ &lt;script&gt;')
})
test('nested XML never accepts code, external resources, duplicate aliases or conditions on required columns',()=>{
  for(const source of [
    fixture(2).replace('<images/>','<images><image src="https://evil.test/a.png"/></images>'),
    fixture(2).replace('<images/>','<images><image slot="../../secret"/></images>'),
    fixture(2).replace('<columns>','<columns><script/>'),
    fixture(2).replace('key="total"','key="total" condicion="HAS_DISCOUNT"'),
    fixture(2).replace('tipo="HEADER"','tipo="HEADER" kind="FOOTER"'),
    '<?xml-stylesheet href="https://evil.test/style"?>'+fixture(2),
    '<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]>'+fixture(2),
    fixture(2).replace('FACTURA','&#0;'),
  ])assert.throws(()=>compileTemplate({source}),{code:'TEMPLATE_INVALID'})
})
test('column widths must describe the full table and sum to 100 percent',()=>{
  for(const source of [fixture(2).replace('width="44"','width="43"'),fixture(2).replace('width="44"','')])assert.throws(()=>compileTemplate({source}),{code:'TEMPLATE_INVALID'})
})
test('malformed source types and orphan column styles are rejected as validation errors',()=>{
  for(const source of [null,23,{}])assert.throws(()=>compileTemplate({source}),{code:'TEMPLATE_INVALID',status:400})
  const d=resolveBase();d.blocks.find(b=>b.kind==='DETAILS').settings={columnStyles:{description:{label:'Detalle'}}}
  assert.throws(()=>compileTemplate({design:d}),{code:'TEMPLATE_INVALID',status:400})
})
test('a visual design that customizes only one column roundtrips without adding phantom settings',()=>{
  const d=resolveBase();d.blocks.find(b=>b.kind==='DETAILS').settings.columnStyles={description:{label:'Mi detalle',align:'left'}}
  const compiled=compileTemplate({design:d})
  assert.deepEqual(compileTemplate({source:compiled.source}).design,compiled.design)
})
test('custom column labels, widths and discount visibility reach the actual PDF',async()=>{
  const os=require('node:os'),{execFileSync}=require('node:child_process'),{freezeProfile,renderDocument}=require('../src/modules/config/documentTemplates/public'),{scenarioData}=require('../src/modules/config/documentTemplates/previews')
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'auna-columns-'))
  try{
    for(const discount of ['0.00','5.00']){
      const design=compileTemplate({source:fixture(2)}).design,data=scenarioData('SHORT','FEL_INVOICE');data.totals.discount=discount
      const result=await renderDocument({data,profile:freezeProfile(design),assets:{},limits:{preview:true}}),file=path.join(dir,'columns.pdf');fs.writeFileSync(file,result.buffer)
      const text=execFileSync('/usr/bin/pdftotext',['-layout',file,'-'],{encoding:'utf8'}),bbox=execFileSync('/usr/bin/pdftotext',['-bbox',file,'-'],{encoding:'utf8'})
      assert.match(text,/Descripción/);assert.match(text,/Total \(Q\)/)
      const description=/<word xMin="([\d.]+)"[^>]*>Descripción<\/word>/.exec(bbox);assert(description)
      const expected=discount==='0.00'?136.1818:124.4
      assert.ok(Math.abs(Number(description[1])-expected)<1,`custom description x: ${description[1]} expected ${expected}`)
      const header=text.split('Descripción')[0].split('\n').at(-1)+text.split('Descripción')[1].split('\n')[0]
      assert.equal(header.includes('Descuento'),discount!=='0.00')
      assert.match(text,/MUESTRA/)
      await assert.rejects(renderDocument({data,profile:freezeProfile(design),assets:{}}),{code:'FISCAL_CONNECTOR_UNAVAILABLE'})
    }
  }finally{fs.rmSync(dir,{recursive:true,force:true})}
})
