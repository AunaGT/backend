const test = require('node:test')
const assert = require('node:assert/strict')
const { compileTemplate, schemaManifest, resolveBase } = require('../src/modules/config/documentTemplates/public')

test('all protected bases produce independent, valid designs for each paper size', () => {
  for (const base of ['CLASSIC','COMPACT','CORPORATE']) for (const format of ['LETTER','A4','RECEIPT_80']) {
    const design = resolveBase(base, format)
    assert.equal(compileTemplate({design}).design.paper.format, format)
    design.blocks[0].settings.title = 'Changed'
    assert.notEqual(resolveBase(base, format).blocks[0].settings.title, 'Changed')
  }
  assert.equal(schemaManifest.schemaVersion, 1)
})
test('unknown fields, hidden required blocks and unsupported styles are rejected instead of silently dropped', () => {
  const mutate = fn => { const d=resolveBase('CLASSIC','A4'); fn(d); return ()=>compileTemplate({design:d}) }
  for (const change of [d=>d.sql='SELECT *',d=>d.paper.format='A3',d=>d.themeOverrides.opacity=0,
    d=>d.blocks=d.blocks.filter(b=>b.kind!=='TOTALS'),d=>d.blocks.find(b=>b.kind==='DETAILS').when='HAS_NOTE',
    d=>d.blocks.find(b=>b.kind==='HEADER').settings.remote='http://bad',d=>d.blocks[1].id=d.blocks[0].id]) {
    assert.throws(mutate(change),{code:'TEMPLATE_INVALID'})
  }
  assert.throws(()=>compileTemplate({design:resolveBase(),source:'x'}),{code:'TEMPLATE_INVALID'})
})
test('font, contrast and layout limits keep mandatory content legible',()=>{
  for(const overrides of [{fontFamily:'Comic Sans'},{textColor:'#ffffff'},{fontSize:1},{spacing:1000}]) {
    const design=resolveBase(); design.themeOverrides=overrides
    assert.throws(()=>compileTemplate({design}),{code:'TEMPLATE_INVALID'})
  }
  const design=resolveBase('CLASSIC','A4','FEL_INVOICE')
  design.blocks=design.blocks.filter(b=>b.kind!=='FISCAL')
  assert.throws(()=>compileTemplate({design}),{code:'TEMPLATE_INVALID'})
})
test('image references are portable slots, never URLs or private asset identifiers',()=>{
  const design=resolveBase();design.blocks[0].settings.images=['imagen-1','imagen-2']
  assert.deepEqual(compileTemplate({design}).design.blocks[0].settings.images,['imagen-1','imagen-2'])
  design.blocks[0].settings.images=['https://host/logo.png']
  assert.throws(()=>compileTemplate({design}),{code:'TEMPLATE_INVALID'})
})
