const test = require('node:test')
const assert = require('node:assert/strict')
let rules = {}
try { rules = require('../src/modules/appointments/domain/engagement') } catch(e) { if(e.code !== 'MODULE_NOT_FOUND') throw e }
const line={quantity:'1.5000',quantityDecimals:2,itemKind:'SERVICE'}
test('completed services still consume the quoted quantity', () => {
  assert.equal(typeof rules.assertLineCoverage,'function')
  assert.equal(rules.assertLineCoverage(line,[{quantity:'1.00',state:'COMPLETED'},{quantity:'0.50',state:'COMMITTED'}]),'0.00')
  assert.throws(()=>rules.assertLineCoverage(line,[{quantity:'1.00',state:'COMPLETED'},{quantity:'1.00',state:'COMMITTED'}]),{code:'OVERBOOKED_QUANTITY'})
})
test('cancelled service keeps quantity until explicit release; no physical good can be scheduled', () => {
  assert.equal(typeof rules.assertLineCoverage,'function')
  assert.equal(rules.assertLineCoverage(line,[{quantity:'1.00',state:'CANCELLED'}]),'0.50')
  assert.equal(rules.assertLineCoverage(line,[{quantity:'1.00',state:'RELEASED'}]),'1.50')
  assert.throws(()=>rules.assertLineCoverage({...line,itemKind:'STANDARD'},[]),{code:'NOT_SERVICE'})
  assert.throws(()=>rules.assertLineCoverage(line,[{quantity:'0.001',state:'COMMITTED'}]),{code:'INVALID_QUANTITY'})
  assert.throws(()=>rules.assertLineCoverage(line,[{quantity:'1',state:'UNKNOWN'}]),{code:'INVALID_COVERAGE_STATE'})
})
