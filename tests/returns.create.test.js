const test = require('node:test')
const assert = require('node:assert/strict')

const {
  DEFAULT_RETURN_POLICY,
  evaluateReturnEligibility,
  normalizeReturnPolicy,
} = require('../src/modules/returns/domain')
const { defaultCompanySettings } = require('../src/services/companySettings')

test('normaliza la política empresarial de devoluciones con defaults seguros', () => {
  assert.deepEqual(normalizeReturnPolicy(null), DEFAULT_RETURN_POLICY)
  assert.deepEqual(normalizeReturnPolicy(JSON.stringify({
    windowDays: 45,
    allowAuthorizedExceptions: false,
    exchangePricing: 'ORIGINAL_SALE_PRICE',
    enabledResolutions: ['REFUND_CASH', 'UNKNOWN', 'REFUND_CASH'],
  })), {
    windowDays: 45,
    allowAuthorizedExceptions: false,
    exchangePricing: 'ORIGINAL_SALE_PRICE',
    enabledResolutions: ['REFUND_CASH'],
  })
})

test('determina elegibilidad por estado, unidades, plazo y excepción auditada', () => {
  const now = new Date('2026-09-29T12:00:00.000Z')
  const base = {
    saleDate: new Date('2026-09-10T12:00:00.000Z'),
    statusName: 'Completada',
    availableUnits: 2,
    policy: DEFAULT_RETURN_POLICY,
    now,
  }

  assert.deepEqual(evaluateReturnEligibility(base), {
    eligible: true,
    daysElapsed: 19,
    reasons: [],
    exceptionApplied: false,
  })

  assert.deepEqual(evaluateReturnEligibility({ ...base, statusName: 'Anulada' }).reasons, ['SALE_NOT_COMPLETED'])
  assert.deepEqual(evaluateReturnEligibility({ ...base, availableUnits: 0 }).reasons, ['NO_RETURNABLE_UNITS'])

  const expired = { ...base, saleDate: new Date('2026-08-01T12:00:00.000Z') }
  assert.deepEqual(evaluateReturnEligibility(expired).reasons, ['RETURN_WINDOW_EXPIRED'])
  assert.equal(evaluateReturnEligibility({
    ...expired,
    override: { authorized: true, reason: 'Garantía aprobada por gerencia' },
  }).eligible, true)
  assert.deepEqual(evaluateReturnEligibility({
    ...expired,
    override: { authorized: true, reason: ' ' },
  }).reasons, ['RETURN_WINDOW_EXPIRED'])
})

test('las empresas nuevas reciben una política de devoluciones configurable', () => {
  const settings = new Map(defaultCompanySettings().map(([key, value, type]) => [key, { value, type }]))
  assert.deepEqual(settings.get('returns.policy'), {
    value: JSON.stringify(DEFAULT_RETURN_POLICY),
    type: 'json',
  })
})

test('return window retains whole 24-hour periods and requires a permitted justified exception',()=>{
  const base={saleDate:new Date('2026-01-01T12:00:00Z'),statusName:'Completada',availableUnits:1,policy:DEFAULT_RETURN_POLICY}
  for(const now of ['2026-01-31T12:00:00Z','2026-02-01T11:59:59.999Z']) assert.equal(evaluateReturnEligibility({...base,now:new Date(now)}).eligible,true)
  const expired={...base,now:new Date('2026-02-01T12:00:00Z')}
  assert.equal(evaluateReturnEligibility(expired).eligible,false)
  for(const [allowed,authorized,reason,eligible] of [[true,true,'Garantía',true],[true,false,'Garantía',false],[true,true,' ',false],[false,true,'Garantía',false]]) assert.equal(evaluateReturnEligibility({...expired,policy:{...DEFAULT_RETURN_POLICY,allowAuthorizedExceptions:allowed},override:{authorized,reason}}).eligible,eligible)
})
