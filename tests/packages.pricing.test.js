const test=require('node:test'), assert=require('node:assert/strict')
const {leaf,id}=require('./helpers/packageFixtures')
const {allocatePackagePrice}=require('../src/modules/inventory/packages/pricing')
const {lineTotal}=require('../src/services/units/quantity')

test('residual cent is stable regardless of caller leaf order',()=>{
  const leaves=[leaf(1),leaf(2),leaf(3)]
  const forward=allocatePackagePrice({amount:'0.05',leaves}),reverse=allocatePackagePrice({amount:'0.05',leaves:[...leaves].reverse()})
  assert.deepEqual(forward.map(l=>l.lineTotal),['0.02','0.01','0.02']);assert.deepEqual(reverse,forward)
})
test('free component is not revenue and a free package never invents a charge',()=>{
  assert.deepEqual(allocatePackagePrice({amount:'10.00',leaves:[leaf(1,'1','0'),leaf(2)]}).map(l=>l.lineTotal),['0.00','10.00'])
  assert.deepEqual(allocatePackagePrice({amount:'0.00',leaves:[leaf(1,'1','0'),leaf(2,'1','0')]}).map(l=>l.lineTotal),['0.00','0.00'])
  assert.throws(()=>allocatePackagePrice({amount:'1.00',leaves:[leaf(1,'1','0')]}),{status:400})
})
test('choice allocation is weighted once, then distributed by agreed quantity',()=>{
  const result=allocatePackagePrice({amount:'100.00',leaves:[leaf(1,'1','20'),leaf(2,'40','80',id(50)),leaf(3,'120','80',id(50))]})
  assert.deepEqual(result.map(l=>l.lineTotal),['20.00','20.00','60.00'])
  assert.deepEqual(result.map(l=>l.unitPrice),['20','0.5','0.5'])
})
test('mixed decimal quantities reproduce their exact assigned totals',()=>{
  const result=allocatePackagePrice({amount:'19.99',leaves:[leaf(1,'0.125'),leaf(2,'1.25')]})
  assert.deepEqual(result.map(l=>l.lineTotal),['10.00','9.99'])
  for(const line of result)assert.equal(lineTotal(line.key.endsWith(id(1))?'0.125':'1.25',line.unitPrice),line.lineTotal)
})
test('one flavor or two flavors preserves the complete package price',()=>{
  const a=allocatePackagePrice({amount:'1599.00',leaves:[leaf(1,'1','20'),leaf(2,'160','80',id(50))]})
  const b=allocatePackagePrice({amount:'1599.00',leaves:[leaf(1,'1','20'),leaf(2,'80','80',id(50)),leaf(3,'80','80',id(50))]})
  assert.deepEqual(a.map(l=>l.lineTotal),['319.80','1279.20'])
  assert.deepEqual(b.map(l=>l.lineTotal),['319.80','639.60','639.60'])
})
test('invalid bounds, duplicate keys and contradictory group weights cannot be priced',()=>{
  for(const amount of ['-1','10000000000.00','1e3','0.001'])assert.throws(()=>allocatePackagePrice({amount,leaves:[leaf(1)]}),{status:400})
  for(const leaves of [[],[leaf(1),leaf(1)],[leaf(1,'0')],[leaf(1,'1','-1')],[leaf(1,'1','1',id(50)),leaf(2,'1','2',id(50))],Array.from({length:101},(_,i)=>leaf(i+1))])assert.throws(()=>allocatePackagePrice({amount:'1.00',leaves}),{status:400})
})
test('unrepresentable unit price requires review rather than a hidden money adjustment',()=>{
  assert.throws(()=>allocatePackagePrice({amount:'9999999999.99',leaves:[leaf(1,'0.000001')]}),{code:'PACKAGE_PRICE_REVIEW_REQUIRED'})
})
