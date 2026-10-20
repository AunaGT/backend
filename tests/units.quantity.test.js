const test = require('node:test')
const assert = require('node:assert/strict')
const { Prisma } = require('@prisma/client')
const { parseQuantity, convertQuantity, lineTotal } = require('../src/services/units/quantity')

// Each fixture catches rejected validation, a wrong conversion, or loss of digits.
test('parses decimal strings exactly and accepts safe legacy integers', () => {
  assert.ok(Prisma.Decimal.isDecimal(parseQuantity('1.250000')))
  assert.equal(parseQuantity('99999999.999999').toFixed(), '99999999.999999')
  assert.equal(parseQuantity(24).toFixed(), '24')
  assert.equal(parseQuantity('-0.5', { signed: true }).toFixed(), '-0.5')
  assert.equal(parseQuantity('0', { allowZero: true }).toFixed(), '0')
})

test('rejects fractional number transport, malformed values, precision and bounds', () => {
  for (const raw of [0.5, Number.MAX_SAFE_INTEGER + 1, -1, '0', '-1', '100000000', '0.0000001', '1e2', '+1', '.5', '1,5', '', true, null, {}, 'Infinity', '1'.repeat(129)]) {
    assert.throws(() => parseQuantity(raw), error => error.status === 400, String(raw))
  }
  assert.throws(() => parseQuantity('-100000000', { signed: true }), { status: 400 })
  assert.throws(() => parseQuantity('0.1', { decimals: 0 }), { status: 400 })
  assert.throws(() => parseQuantity('2', { max: '1' }), { status: 400 })
  for (const decimals of [-1, 1.5, 13]) assert.throws(() => parseQuantity('1', { decimals }), { status: 400 })
})

test('converts cases, kilograms and grams to base without changing dimension', () => {
  for (const [qty, factor, decimals, want] of [['2','24',0,'48'], ['1.25','1',6,'1.25'], ['500','0.001',6,'0.5']]) {
    assert.deepEqual(convertQuantity(qty, factor, { baseDecimals: decimals }), { baseQty: want, exactBaseQty: want, roundingDelta: '0', roundingRequired: false })
  }
})

test('accepts persisted Decimal objects and preserves the legacy service boundary', () => {
  const { commercialQuantity } = require('../src/services/catalogItemRules')
  const persisted = new Prisma.Decimal('1.2500')
  assert.equal(parseQuantity(persisted).toFixed(), '1.25')
  assert.equal(convertQuantity(persisted, new Prisma.Decimal('1'), {baseDecimals:4}).baseQty,'1.25')
  assert.equal(lineTotal(persisted, new Prisma.Decimal('10.00')), '12.50')
  assert.equal(commercialQuantity(persisted, {kind:'SERVICE',quantity_decimals:4}).toFixed(),'1.25')
  assert.throws(() => commercialQuantity(new Prisma.Decimal('1.00001'), {kind:'SERVICE',quantity_decimals:4}),{status:400})
  assert.throws(() => commercialQuantity(persisted, {kind:'STANDARD',quantity_decimals:6}),{status:400})
})

test('rejects invalid factors, commercial precision, overflow and indivisible fractions', () => {
  for (const factor of ['0', '-1', '100000000', '0.0000000000001', '1e2', 0.5]) {
    assert.throws(() => convertQuantity('1', factor), { status: 400 })
  }
  assert.throws(() => convertQuantity('99999999', '2'), { status: 400 })
  assert.throws(() => convertQuantity('0.5', '1', { allowRounding: true }), { status: 400 })
  assert.throws(() => convertQuantity('0.5', '1', { commercialDecimals: 0 }), { status: 400 })
  assert.throws(() => convertQuantity('1', '1', { baseDecimals: 7 }), { status: 400 })
})

test('requires explicit acceptance of divisible rounding and returns the exact review', () => {
  const review = { baseQty:'0.453592', exactBaseQty:'0.45359237', roundingDelta:'-0.00000037', roundingRequired:true }
  assert.throws(() => convertQuantity('1','0.45359237',{baseDecimals:6}), error => {
    assert.equal(error.status,400)
    assert.equal(error.code,'QUANTITY_ROUNDING_REQUIRED')
    assert.deepEqual(error.details,review)
    return true
  })
  assert.deepEqual(convertQuantity('1','0.45359237',{baseDecimals:6,allowRounding:true}),review)
  assert.deepEqual(convertQuantity('1','0.0000015',{baseDecimals:6,allowRounding:true}), {
    baseQty:'0.000002',exactBaseQty:'0.0000015',roundingDelta:'0.0000005',roundingRequired:true,
  })
  assert.throws(() => convertQuantity('1','0.0000001',{baseDecimals:6,allowRounding:true}), { status:400 })
})

test('preserves all multiplication digits independently of global decimal precision', () => {
  const precision = Prisma.Decimal.precision
  try {
    Prisma.Decimal.set({precision:10})
    assert.deepEqual(convertQuantity('99999999.999999','0.999999999999',{baseDecimals:6,allowRounding:true}), {
      baseQty:'99999999.999899',exactBaseQty:'99999999.999899000000000001',roundingDelta:'-0.000000000000000001',roundingRequired:true,
    })
    assert.equal(parseQuantity('0.000001').toFixed(),'0.000001')
  } finally { Prisma.Decimal.set({precision}) }
})

test('rounds line totals once half up and retains the existing monetary ceiling', () => {
  assert.equal(lineTotal('3','0.333333'),'1.00')
  assert.equal(lineTotal('1','0.005'),'0.01')
  assert.equal(lineTotal('0.5','0.01'),'0.01')
  assert.equal(lineTotal('2','0'),'0.00')
  assert.equal(lineTotal('1','9999999999.99'),'9999999999.99')
  for (const args of [['2','9999999999.99'], ['0','1'], ['1','-1'], ['1','0.0000000000000000001'], ['1',0.5]]) {
    assert.throws(() => lineTotal(...args), {status:400})
  }
})
test('derived eighteen-decimal prices preserve money until the final cent rounding',()=>{
  assert.equal(lineTotal('10000000','0.000000123'),'1.23')
  assert.equal(lineTotal('99999999','0.000000000100000001'),'0.01')
  assert.throws(()=>parseQuantity('1',{decimals:18}),{status:400})
})
