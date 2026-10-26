const test=require('node:test'), assert=require('node:assert/strict')
const {definition,id}=require('./helpers/packageFixtures')
const {parsePackageDefinition}=require('../src/modules/inventory/packages/definition')

test('definition normalizes decimal strings without inferring prices or products',()=>{
  const raw=definition();raw.variants[0].price='1599';raw.variants[0].components[0].quantity='1.000000'
  const parsed=parsePackageDefinition(raw,{complete:true})
  assert.equal(parsed.variants[0].price,'1599.00');assert.equal(parsed.variants[0].components[0].quantity,'1')
  assert.equal(parsed.currency,'GTQ');assert.equal(parsed.variants[0].choices[0].maxDistinct,2)
  assert.equal(raw.variants[0].price,'1599')
})
test('rejects untrusted definition fields and inherited or executable properties',()=>{
  for(const key of ['cost','script','__proto__']){
    const raw=JSON.parse(JSON.stringify(definition()).replace('"schemaVersion":1',`"schemaVersion":1,"${key}":"bad"`))
    assert.throws(()=>parsePackageDefinition(raw,{complete:true}),{status:400})
  }
  assert.throws(()=>parsePackageDefinition(Object.assign(Object.create({cost:1}),definition()),{complete:true}),{status:400})
  const raw=definition();let evaluated=false;Object.defineProperty(raw,'name',{get(){evaluated=true;return 'unsafe'},enumerable:true})
  assert.throws(()=>parsePackageDefinition(raw,{complete:true}),{status:400});assert.equal(evaluated,false)
})
test('definition rejects unsafe money, quantities, negative weights and unknown nested fields',()=>{
  for(const value of ['1e3','Infinity',Infinity,-1,'-1','10000000000.00','0.001']){
    const raw=definition();raw.variants[0].price=value
    assert.throws(()=>parsePackageDefinition(raw,{complete:true}),{status:400})
  }
  for(const value of ['-1','1.00001','1000001',Infinity]){
    const raw=definition();raw.variants[0].choices[0].weight=value
    assert.throws(()=>parsePackageDefinition(raw,{complete:true}),{status:400})
  }
  const raw=definition();raw.variants[0].components[0].baseQty='999'
  assert.throws(()=>parsePackageDefinition(raw,{complete:true}),{status:400})
})
test('activation needs named variants, components and a valid non-cost allocation',()=>{
  for(const change of [r=>r.name='',r=>r.variants=[],r=>r.variants[0].components=[],r=>r.variants[0].choices[0].options=[],r=>r.variants[0].choices[0].maxDistinct=4]){
    const raw=definition();change(raw)
    // A choices-only package is valid; remove its choices as well for an empty composition.
    if(!raw.variants[0]?.components.length&&raw.variants[0])raw.variants[0].choices=[]
    assert.throws(()=>parsePackageDefinition(raw,{complete:true}),{status:400})
  }
  const raw=definition();raw.variants[0].components[0].weight='0';raw.variants[0].choices[0].weight='0'
  assert.throws(()=>parsePackageDefinition(raw,{complete:true}),{status:400})
  raw.variants[0].price='0';assert.equal(parsePackageDefinition(raw,{complete:true}).variants[0].price,'0.00')
})
test('an unfinished catalog draft can be saved but cannot be activated',()=>{
  const raw={schemaVersion:1,name:'',currency:'GTQ',variants:[]}
  assert.equal(parsePackageDefinition(raw,{complete:false}).name,'')
  assert.throws(()=>parsePackageDefinition(raw,{complete:true}),{status:400})
  const partial=definition();partial.variants[0].components[0].productId=null;partial.variants[0].price=null
  assert.equal(parsePackageDefinition(partial,{complete:false}).variants[0].price,null)
  assert.throws(()=>parsePackageDefinition(partial,{complete:true}),{status:400})
})
test('definition enforces bounds and unique references without duplicate product flavors',()=>{
  const tooMany=definition();tooMany.variants=Array.from({length:21},(_,i)=>({...tooMany.variants[0],id:id(1000+i)}))
  assert.throws(()=>parsePackageDefinition(tooMany,{complete:true}),{status:400})
  const duplicate=definition();duplicate.variants[0].choices[0].options[1].productId=id(21)
  assert.throws(()=>parsePackageDefinition(duplicate,{complete:true}),{status:400})
  const duplicateId=definition();duplicateId.variants[0].choices[0].options[1].id=id(2)
  assert.throws(()=>parsePackageDefinition(duplicateId,{complete:true}),{status:400})
  const large=definition();large.description='x'.repeat(2001)
  assert.throws(()=>parsePackageDefinition(large,{complete:false}),{status:400})
})
test('image URLs cannot carry secrets, scripts or server-side fetch instructions',()=>{
  for(const imageUrl of ['javascript:alert(1)','http://example.com/a.png','https://user:secret@example.com/a.png','https://example.com/a.png?token=secret','https://example.com/a.png#x']){
    assert.throws(()=>parsePackageDefinition({...definition(),imageUrl},{complete:true}),{status:400})
  }
  assert.equal(parsePackageDefinition({...definition(),imageUrl:'https://example.com/a.png'},{complete:true}).imageUrl,'https://example.com/a.png')
})
