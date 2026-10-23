const test=require('node:test'),assert=require('node:assert/strict')
const {resolveBase,freezeProfile,compileTemplate}=require('../src/modules/config/documentTemplates/public')
test('company appearance supplies inherited content and local overrides win without mutating the draft',()=>{
  const design=resolveBase('CLASSIC','A4');delete design.blocks[0].settings.title;delete design.blocks.at(-1).settings.text
  const frozen=freezeProfile(design,{fontFamily:'Montserrat',headerText:'Tu compra',footerText:'Volvé pronto',preferredFormat:'A4'})
  assert.equal(frozen.design.blocks[0].settings.title,'Tu compra');assert.equal(frozen.design.blocks.at(-1).settings.text,'Volvé pronto')
  assert.equal(design.blocks[0].settings.title,undefined)
  design.blocks[0].settings.title='Texto propio';design.themeOverrides={fontFamily:'Helvetica'}
  const local=freezeProfile(design,{fontFamily:'Montserrat',headerText:'Empresa'})
  assert.equal(local.design.blocks[0].settings.title,'Texto propio');assert.equal(local.resolvedTheme.fontFamily,'Helvetica')
  assert.doesNotThrow(()=>compileTemplate({design:local.design}))
})
test('a captured base fallback does not depend on custom image slots',()=>{
  const profile=freezeProfile(resolveBase(),{},[{id:'imagen-1',role:'image',path:'immutable-custom-image'},{id:'company-logo',role:'logo',sourceUrl:'immutable-logo'}])
  assert.deepEqual(profile.fallbackProfile.resourceRefs,[{id:'company-logo',role:'logo',sourceUrl:'immutable-logo'}])
})
