const test=require('node:test'),assert=require('node:assert/strict')
const api=()=>require('../src/services/payroll/rateVersions')
const {DEFAULT_RATES}=require('../src/services/payroll/rates')
function memory(){
  const rows=[],db={systemSetting:{findUnique:async()=>({value:JSON.stringify({...DEFAULT_RATES,bonificacionIncentivo:300})})},payrollRun:{count:async()=>0},$executeRaw:async()=>0,
    payrollRateVersion:{findMany:async({where})=>rows.filter(r=>r.company_id===where.company_id),findFirst:async({where})=>rows.find(r=>Object.entries(where).every(([k,v])=>r[k]===v))||null,
      create:async({data})=>{const row={id:'v'+(rows.length+1),cancelled_at:null,...data};rows.push(row);return row},update:async({where,data})=>Object.assign(rows.find(r=>r.id===where.id),data)}}
  db.$transaction=async fn=>fn(db);return{db,rows}
}
test('rates validate every complete parameter without coercing empty or object input',()=>{
  const {validatePayrollRates}=api()
  assert.equal(validatePayrollRates({...DEFAULT_RATES,igssLaboral:'0.05'}).igssLaboral,.05)
  for(const patch of [{igssLaboral:true},{irtra:[]},{intecap:''},{igssPatronal:1.01},{horaExtraFactor:0},{horaExtraFactor:11},{bonificacionIncentivo:1e12+1},{isrDeduccionUnica:null}])assert.throws(()=>validatePayrollRates({...DEFAULT_RATES,...patch}),e=>e.status===400)
  assert.throws(()=>validatePayrollRates({igssLaboral:.05}),e=>e.status===400)
})
test('pay-date resolver isolates companies, captures legacy once and excludes cancelled/future versions',async()=>{
  const {db,rows}=memory(),{resolvePayrollRates,publishPayrollRates,cancelPayrollRates}=api(),scope={companyId:'A',userId:null},now=new Date('2026-10-16T15:00:00Z')
  assert.equal((await resolvePayrollRates(db,'A','2026-01-01')).source,'legacy')
  const version=await publishPayrollRates(db,scope,{effectiveFrom:'2026-11-01',reason:'Ajuste aprobado',rates:{...DEFAULT_RATES,igssLaboral:.06}},now)
  assert.equal(rows.filter(r=>r.is_baseline).length,1);assert.equal(rows.find(r=>r.is_baseline).effective_from,null)
  db.systemSetting.findUnique=async()=>({value:JSON.stringify({...DEFAULT_RATES,bonificacionIncentivo:900})})
  assert.equal((await resolvePayrollRates(db,'A','2026-10-31')).rates.bonificacionIncentivo,300)
  assert.equal((await resolvePayrollRates(db,'A','2026-11-01')).versionId,version.id)
  assert.equal((await resolvePayrollRates(db,'A','2026-12-01')).rates.igssLaboral,.06)
  assert.equal((await resolvePayrollRates(db,'B','2026-12-01')).rates.igssLaboral,.0483)
  await assert.rejects(publishPayrollRates(db,scope,{effectiveFrom:'2026-11-01',reason:'Duplicado',rates:DEFAULT_RATES},now),e=>e.status===409)
  await assert.rejects(publishPayrollRates(db,scope,{effectiveFrom:'2026-02-30',reason:'Fecha inválida',rates:DEFAULT_RATES},now),e=>e.status===400)
  await assert.rejects(publishPayrollRates(db,scope,{effectiveFrom:'2026-10-15',reason:'Retroactiva',rates:DEFAULT_RATES},now),e=>e.status===400)
  db.payrollRun.count=async()=>1
  await assert.rejects(cancelPayrollRates(db,scope,version.id,{reason:'Aplicada'},now),e=>e.status===409)
  db.payrollRun.count=async()=>0;await cancelPayrollRates(db,scope,version.id,{reason:'Reemplazar'},now)
  assert.equal((await resolvePayrollRates(db,'A','2026-12-01')).source,'baseline')
  await assert.rejects(cancelPayrollRates(db,scope,rows.find(r=>r.is_baseline).id,{reason:'Base'},now),e=>e.status===409)
})
test('rates access requires both domain capabilities; snapshots do not read live rates',async()=>{
  const {requireRatesAccess,ratesForRun,lockPayrollRun}=api()
  for(const permissions of [['settings.manage'],['payroll.confirm'],['settings.view','payroll.view']])assert.throws(()=>requireRatesAccess({permissions},true),e=>e.status===403)
  requireRatesAccess({permissions:['settings.manage','payroll.confirm']},true)
  assert.throws(()=>requireRatesAccess({permissions:['settings.view']},false),e=>e.status===403)
  requireRatesAccess({permissions:['settings.view','payroll.view']},false)
  const snapshot={rates:{...DEFAULT_RATES,igssLaboral:.04},versionId:null,source:'legacy',capturedAt:'2026-10-16T00:00:00Z'}
  assert.equal(ratesForRun({rates_snapshot:snapshot}).igssLaboral,.04)
  assert.throws(()=>ratesForRun({rates_snapshot:null}),e=>e.status===409)
  let locked=false
  const tx={$queryRaw:async(strings,...values)=>{assert.match(strings.join(''),/FOR UPDATE/);assert.deepEqual(values,['R','A','B']);locked=true;return[{id:'R'}]},payrollRun:{findFirst:async()=>{assert.equal(locked,true);return{id:'R',status:'PAGADA'}}}}
  assert.equal((await lockPayrollRun(tx,{id:'R',companyId:'A',branchId:'B'})).status,'PAGADA')
})
test('paid runs reject recalculation/adoption before touching receipts; legacy drafts require explicit adoption',async()=>{
  const {withMocks,jsonResponse}=require('./helpers/reportHarness.cjs'),id='11111111-1111-4111-8111-111111111111'
  let run={id,company_id:'A',branch_id:'B',status:'PAGADA',rates_snapshot:null},deletes=0
  const db={$queryRaw:async()=>[{id}],payrollRun:{findFirst:async()=>run},payslip:{deleteMany:async()=>{deletes++}}};db.$transaction=fn=>fn(db)
  await withMocks({[require.resolve('../src/models/prisma')]:{prisma:db,prismaTransaction:db}},require.resolve('../src/modules/payroll/controllers/payroll'),async controller=>{
    const req={companyId:'A',branchId:'B',params:{id},body:{confirmed:true}},errors=[]
    await controller.recalculate(req,jsonResponse(),e=>errors.push(e));await controller.adoptRates(req,jsonResponse(),e=>errors.push(e))
    assert.deepEqual(errors.map(e=>e.status),[409,409]);assert.equal(deletes,0)
    run={...run,status:'BORRADOR'}
    await controller.recalculate(req,jsonResponse(),e=>errors.push(e));assert.equal(errors[2].status,409);assert.equal(deletes,0)
    assert.equal(typeof controller.previewRates,'function')
  })
})
