const test = require('node:test')
const assert = require('node:assert/strict')

const {
  DEFAULT_RETURN_POLICY,
  evaluateReturnEligibility,
  normalizeReturnPolicy,
  returnRequestDateForStorage,
  returnRequestInstant,
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

test('request clock roundtrip preserves the existing Guatemala storage convention without shifting eligibility',()=>{
  for(const instant of ['2026-02-01T12:00:00.000Z','2026-01-31T03:00:00.123Z']) {
    const stored=returnRequestDateForStorage(new Date(instant))
    assert.equal(stored.toISOString(),instant==='2026-02-01T12:00:00.000Z'?'2026-02-01T06:00:00.000Z':'2026-01-30T21:00:00.123Z')
    assert.equal(returnRequestInstant(stored).toISOString(),instant)
  }
  const base={saleDate:new Date('2026-01-01T12:00:00Z'),statusName:'Completada',availableUnits:1,policy:{...DEFAULT_RETURN_POLICY,allowAuthorizedExceptions:false}}
  for(const [request,eligible] of [['2026-02-01T11:59:59.999Z',true],['2026-02-01T12:00:00.000Z',false]]) {
    const now=returnRequestInstant(returnRequestDateForStorage(new Date(request)))
    assert.equal(evaluateReturnEligibility({...base,now}).eligible,eligible)
  }
})

test('creation uses the same request instant for eligibility and the stored request clock',async t=>{
  const {withMocks,jsonResponse}=require('./helpers/reportHarness.cjs')
  const target=require.resolve('../src/modules/returns/controller'),model=require.resolve('../src/models/prisma'),domain=require.resolve('../src/modules/returns/domain')
  const realDomain=require(domain),requestAt=new Date('2026-02-01T12:00:00.000Z')
  t.mock.timers.enable({apis:['Date'],now:requestAt})
  let created,eligibilityInstant
  const sale={id:'S',date:new Date('2026-01-01T12:00:00Z'),status:{name:'Completada'},branch_id:'B',branch:{id:'B'},total:90,returns:[],sale_items:[{id:1,product_id:'P',qty:1,price:90,return_items:[],product:{kind:'STANDARD'}}]}
  const tx={$queryRaw:async()=>[],sale:{findFirst:async()=>sale},systemSetting:{findUnique:async()=>null},returnStatus:{findFirst:async()=>({id:1})},return:{create:async({data})=>{created={id:'R',...data};return created}},returnItem:{create:async()=>{}}}
  const db={sale:{findFirst:async()=>({id:'S'})},$transaction:async fn=>fn(tx),return:{findUnique:async()=>created}}
  await withMocks({[model]:{prisma:db,prismaTransaction:db},[require.resolve('../src/services/referenceGenerator')]:{nextDocumentReference:async()=>'D-1'},[domain]:{...realDomain,evaluateReturnEligibility:args=>{eligibilityInstant=args.now;t.mock.timers.tick(1);return realDomain.evaluateReturnEligibility({...args,now:requestAt})}}},target,async controller=>{
    const res=jsonResponse();await controller.create({companyId:'A',branchId:'B',user:{sub:'U',role_name:'admin'},body:{sale_id:'S',reason:'Garantía',policy_override_reason:'Autorizada',requested_resolution:'REFUND_CASH',items:[{sale_item_id:1,product_id:'P',qty_returned:1}]}},res,e=>{throw e})
    assert.equal(res.statusCode,201)
  })
  assert.equal(eligibilityInstant?.toISOString(),requestAt.toISOString())
  assert.equal(created.return_date.toISOString(),'2026-02-01T06:00:00.000Z')
  assert.equal(created.policy_overridden_by,'U')
  // Change policy after creation: its persisted authorized exception must no
  // longer permit either approval or completion at this exact boundary.
  const {approveReturn,completeReturn}=require('../src/modules/returns/application')
  tx.systemSetting.findUnique=async()=>({value:JSON.stringify({...DEFAULT_RETURN_POLICY,allowAuthorizedExceptions:false})})
  const record={...created,sale,status:{name:'Pendiente'},return_items:[{id:1,qty_returned:1}]}
  tx.return.findFirst=async()=>record
  await assert.rejects(approveReturn(tx,{id:'R',companyId:'A',scope:{branch_id:'B'},resolution:'REFUND_CASH'}),e=>e.status===409 && /plazo/i.test(e.message))
  record.status={name:'Aprobada'};record.approved_resolution='REFUND_CASH'
  tx.returnSettlement={findFirst:async()=>null}
  await assert.rejects(completeReturn(db,{id:'R',companyId:'A',scope:{branch_id:'B'},payload:{idempotency_key:'boundary'}}),e=>e.status===409 && /plazo/i.test(e.message))
})
