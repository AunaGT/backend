const {test}=require('node:test'),assert=require('node:assert/strict')
const v=require('../src/modules/inventory/barcodeLabels/validation')
const {encodeLabelBarcode}=require('../src/modules/inventory/barcodeLabels/encoding')
test('templates protect barcode and original readable value',()=>{
  for(const preset of ['essential','product','price']){
    const design=v.createLabelTemplate(preset)
    assert.deepEqual(v.parseLabelDesign(design),design)
    assert.equal(design.elements.filter(e=>e.kind==='barcode').length,1)
    assert.ok(design.elements.some(e=>e.kind==='field'&&e.field==='barcode'))
    assert.throws(()=>v.parseLabelDesign({...design,elements:design.elements.filter(e=>e.kind!=='barcode')}))
    assert.throws(()=>v.parseLabelDesign({...design,elements:design.elements.map(e=>e.kind==='barcode'?{...e,visible:false}:e)}))
  }
})
test('geometry, payload keys, variants and paper cannot silently create invalid labels',()=>{
  const design=v.createLabelTemplate('product')
  assert.throws(()=>v.parseLabelDesign({...design,widthMm:Infinity}))
  assert.throws(()=>v.parseLabelDesign({...design,elements:[...design.elements,{id:'overlay',kind:'shape',shape:'rect',x:0,y:0,width:1,height:1,visible:true,locked:false,color:'#000000',borderColor:'#000000',borderWidth:0}]}))
  assert.throws(()=>v.parsePaperSettings({...v.defaultPaper(),widthMm:0}))
  assert.throws(()=>v.parseLabelDesign({...design,companyId:'other'}))
  const field=design.elements.find(e=>e.kind==='field')
  assert.throws(()=>v.parseLabelDesign({...design,elements:design.elements.map(e=>e===field?{...e,style:{...e.style,font:'Pacifico',bold:true}}:e)}))
})
test('human readable value cannot be covered by a decoration either',()=>{
  const d=v.createLabelTemplate('essential'),readable=d.elements.find(e=>e.field==='barcode')
  assert.throws(()=>v.parseLabelDesign({...d,elements:[...d.elements,{id:'cover',kind:'shape',shape:'rect',x:readable.x,y:readable.y,width:readable.width,height:readable.height,visible:true,locked:false,color:'#ffffff',borderColor:'#ffffff',borderWidth:0}]}))
})
test('UPC and EAN preserve exact values and require supplied valid check digits',()=>{
  for(const [type,value]of [['upca','012345000058'],['ean13','4006381333931'],['ean8','96385074'],['code128','AUNA123456789ABC']]){
    const encoded=encodeLabelBarcode(value,type,{width:100,height:40})
    assert.equal(encoded.value,value);assert.ok(encoded.bars.length>0)
  }
  assert.throws(()=>encodeLabelBarcode('012345000059','upca',{width:100,height:40}))
  assert.throws(()=>encodeLabelBarcode('400638133393','ean13',{width:100,height:40}))
  assert.throws(()=>encodeLabelBarcode('96385074','ean8',{width:2,height:1}))
})
test('preparation limits and assignment confirmation are enforced before any write',()=>{
  const raw={requestKey:'22222222-2222-4222-8222-222222222222',scope:{branchId:'33333333-3333-4333-8333-333333333333',inBranch:false},items:[{productId:'11111111-1111-4111-8111-111111111111',copies:1,expectedBarcode:null,assignment:{mode:'auto'}}],design:v.createLabelTemplate(),paper:v.defaultPaper(),confirmAssignments:true}
  assert.equal(v.parsePreparationInput(raw).items[0].copies,1)
  for(const copies of [0,1.5,1001,NaN,Infinity])assert.throws(()=>v.parsePreparationInput({...raw,items:[{...raw.items[0],copies}]}))
  assert.throws(()=>v.parsePreparationInput({...raw,confirmAssignments:false}))
  assert.throws(()=>v.parsePreparationInput({...raw,design:{...raw.design,barcodeType:'ean13'}}))
  assert.throws(()=>v.parsePreparationInput({...raw,items:[raw.items[0],raw.items[0]]}))
})
