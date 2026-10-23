const test=require('node:test')
const assert=require('node:assert/strict')
const {compileTemplate,resolveBase}=require('../src/modules/config/documentTemplates/public')
test('XML roundtrip preserves the complete supported visual design and escaped text',()=>{
  const design=resolveBase('CORPORATE','A4')
  design.blocks[0].settings.title='Comprobante & café <especial> "A"'
  design.themeOverrides={fontFamily:'Montserrat',accentColor:'#a84408'}
  const compiled=compileTemplate({design})
  assert.match(compiled.source,/<plantilla-factura version="1"/)
  assert.deepEqual(compileTemplate({source:compiled.source}).design,compiled.design)
})
test('unsafe XML, arbitrary expressions and foreign invoice dialects cannot compile',()=>{
  for(const source of ['<!DOCTYPE x><plantilla-factura version="1"/>','<?xml version="1.0"?><plantilla-factura/>',
    '<plantilla-factura version="1" version="2"/>','<plantilla-factura version="1">&evil;</plantilla-factura>',
    '<t t-name="invoice"/>','<dte:GTDocumento xmlns:dte="x"/>','<script>alert(1)</script>',
    '<plantilla-factura version="1"><bloque></plantilla-factura>']) {
    assert.throws(()=>compileTemplate({source}),e=>e.code==='TEMPLATE_INVALID'&&e.diagnostics[0].line>=1)
  }
})
test('XML bounds fail before processing unbounded content',()=>{
  for(const source of ['x'.repeat(262145),'<a>'.repeat(13)+'</a>'.repeat(13),'<a>'+ '<b/>'.repeat(201)+'</a>'])
    assert.throws(()=>compileTemplate({source}),{code:'TEMPLATE_INVALID'})
})
test('semantic XML errors identify the actual attribute line, not always the root line',()=>{
  const source=compileTemplate({design:resolveBase()}).source.replace(/<tema[^>]*\/>/,'<tema fontFamily="Comic Sans"/>')
  assert.throws(()=>compileTemplate({source}),error=>error.code==='TEMPLATE_INVALID'&&error.diagnostics[0].line===2&&error.diagnostics[0].path==='themeOverrides.fontFamily')
})
