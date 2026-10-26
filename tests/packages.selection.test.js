const test=require('node:test'), assert=require('node:assert/strict')
const {id,definition,selection}=require('./helpers/packageFixtures')
const {parsePackageSelections,validatePackageSelection}=require('../src/modules/inventory/packages/selection')

test('agreement is completed during quote when the chosen quantities sum to the contracted total',()=>{
  const result=validatePackageSelection(definition(),selection())
  assert.equal(result.state,'COMPLETE');assert.deepEqual(result.issues,[])
  assert.deepEqual(result.leaves.map(l=>[l.productId,l.quantity]).sort(),[[id(20),'1'],[id(21),'80'],[id(22),'80']])
})
test('incomplete choice remains explicit without inventing flavor quantities or sale lines',()=>{
  const result=validatePackageSelection(definition(),selection([{optionId:id(4),quantity:'80'}]))
  assert.equal(result.state,'INCOMPLETE');assert.equal(result.issues[0].code,'PACKAGE_SELECTION_INCOMPLETE')
  assert.equal(result.issues[0].remainingQuantity,'80');assert.deepEqual(result.leaves,[])
  const missing=validatePackageSelection(definition(),{...selection(),choices:[]})
  assert.equal(missing.state,'INCOMPLETE');assert.equal(missing.issues[0].remainingQuantity,'160')
})
test('excess, unavailable choices, duplicate flavors and a third flavor are invalid, not incomplete',()=>{
  for(const items of [
    [{optionId:id(4),quantity:'161'}],
    [{optionId:id(99),quantity:'160'}],
    [{optionId:id(4),quantity:'80'},{optionId:id(4),quantity:'80'}],
    [{optionId:id(4),quantity:'60'},{optionId:id(5),quantity:'60'},{optionId:id(6),quantity:'40'}],
  ])assert.throws(()=>validatePackageSelection(definition(),selection(items)),{status:400})
  assert.throws(()=>validatePackageSelection(definition(),{...selection(),variantId:id(99)}),{status:400})
  assert.throws(()=>validatePackageSelection(definition(),{...selection(),choices:[{choiceId:id(99),items:[]}]}),{status:400})
})
test('decimal totals are checked exactly rather than using binary floating point',()=>{
  const raw=definition();raw.variants[0].choices[0].totalQuantity='0.3'
  const result=validatePackageSelection(raw,selection([{optionId:id(4),quantity:'0.1'},{optionId:id(5),quantity:'0.2'}]))
  assert.equal(result.state,'COMPLETE')
})
test('same product in two groups keeps two origin keys',()=>{
  const first=validatePackageSelection(definition(),selection()).leaves
  const second=validatePackageSelection(definition(),{...selection(),groupId:id(102)}).leaves
  assert.equal(first[0].productId,second[0].productId);assert.notEqual(first[0].key,second[0].key)
  assert.equal(new Set([...first,...second].map(l=>l.key)).size,6)
})
test('selection parser rejects price overrides, snapshots, invalid identity and unsafe quantities',()=>{
  assert.equal(parsePackageSelections([selection()])[0].choices[0].items[0].quantity,'80')
  for(const extra of [{price:'1'},{snapshot:{}},{state:'COMPLETE'},{weight:'100'}])assert.throws(()=>parsePackageSelections([{...selection(),...extra}]),{status:400})
  for(const quantity of ['0','-1','1e3','Infinity',1,'1.0000001'])assert.throws(()=>parsePackageSelections([selection([{optionId:id(4),quantity}])]),{status:400})
  assert.throws(()=>parsePackageSelections([{...selection(),version:0}]),{status:400})
  assert.throws(()=>parsePackageSelections([selection(),selection()]),{status:400})
  assert.throws(()=>parsePackageSelections([Object.assign(Object.create({price:'1'}),selection())]),{status:400})
})
