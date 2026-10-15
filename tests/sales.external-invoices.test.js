const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto')
let fiscalState,parseExternalInvoice
try{({fiscalState,parseExternalInvoice}=require('../src/modules/sales/externalInvoices'))}catch(e){if(e.code!=='MODULE_NOT_FOUND')throw e}
const input=()=>({expectedVersion:1,idempotencyKey:crypto.randomUUID(),documentType:'FACT',authorization:'ABC-123',series:'A',number:'1',date:'2026-10-14'})
test('fiscal evidence is never inferred from payment or incomplete historical metadata',()=>{
  assert.equal(typeof fiscalState,'function')
  assert.equal(fiscalState([]),'UNRECORDED')
  assert.equal(fiscalState([{status:'AUTHORIZED',authorization:null}]),'REVIEW_REQUIRED')
  const complete={document_type:'FACT',authorization:'ABC',series:'A',number:'1',emission_date:new Date('2026-10-14')}
  assert.equal(fiscalState([{...complete,provider:'EXTERNAL',status:'RECORDED_EXTERNAL'}]),'RECORDED_EXTERNAL')
  assert.equal(fiscalState([{...complete,provider:'INFILE',status:'AUTHORIZED'}]),'AUTHORIZED')
  assert.equal(fiscalState([{...complete,provider:'EXTERNAL',status:'AUTHORIZED'}]),'REVIEW_REQUIRED')
  assert.equal(fiscalState([{...complete,provider:'INFILE',status:'AUTHORIZED'},{status:'REJECTED'}]),'REVIEW_REQUIRED')
})
test('external document input rejects impossible dates and browser-controlled legal state',()=>{
  assert.equal(typeof parseExternalInvoice,'function')
  assert.equal(parseExternalInvoice({...input(),authorization:' ABC-123 '}).authorization,'ABC-123')
  for(const date of ['2026-02-31','2025-02-29','2026-13-01','2026-1-1'])assert.throws(()=>parseExternalInvoice({...input(),date}),{code:'INVALID_INPUT'})
  for(const [key,value]of [['status','AUTHORIZED'],['provider','INFILE'],['pdf_url','https://malicious.invalid'],['authorization','\n'],['series',''],['number',''],['documentType','']])assert.throws(()=>parseExternalInvoice({...input(),[key]:value}),{code:'INVALID_INPUT'})
  assert.equal(parseExternalInvoice({...input(),date:'2024-02-29'}).date,'2024-02-29')
})
test('fiscal permission registration writes catalog only and never grants existing roles',async()=>{
  let registerSalesFiscalPermission
  try{({registerSalesFiscalPermission}=require('../scripts/register-sales-fiscal-permission'))}catch(e){if(e.code!=='MODULE_NOT_FOUND')throw e}
  assert.equal(typeof registerSalesFiscalPermission,'function')
  const rows=[]
  await registerSalesFiscalPermission({permission:{upsert:async({where,create,update})=>{assert.equal(where.code,'sales.fiscal.register');assert.equal(update.name,'Solicitar facturación electrónica');rows.push(create);return create}}})
  assert.equal(rows.length,1);assert.equal(rows[0].code,'sales.fiscal.register')
})
