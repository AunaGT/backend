require('../src/config/loadEnv')
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto'),{PrismaClient}=require('@prisma/client')
const {DEFAULT_RATES}=require('../src/services/payroll/rates')
const {publishPayrollRates,cancelPayrollRates,resolvePayrollRates,lockPayrollRun}=require('../src/services/payroll/rateVersions')
test('existing development Supabase serializes publication and run recalculation/confirmation',async()=>{
  const db=new PrismaClient({datasources:{db:{url:process.env.DIRECT_URL||process.env.DATABASE_URL}}}),companyId=randomUUID(),branchId=randomUUID(),id=randomUUID(),scope={companyId,userId:null}
  try{
    await db.company.create({data:{id:companyId,name:'QA tasas identificadas',code:`pr-${companyId.slice(0,12)}`}})
    await db.branch.create({data:{id:branchId,company_id:companyId,name:'QA tasas',code:'QA'}})
    const input={effectiveFrom:'2099-01-01',reason:'Ensayo identificado de concurrencia',rates:DEFAULT_RATES}
    const results=await Promise.allSettled([publishPayrollRates(db,scope,input),publishPayrollRates(db,scope,input)])
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.status,409)
    const version=results.find(r=>r.status==='fulfilled').value
    const resolved=await resolvePayrollRates(db,companyId,'2099-01-01');assert.equal(resolved.versionId,version.id)
    await db.payrollRun.create({data:{id,company_id:companyId,branch_id:branchId,code:'NOM-QA',name:'QA',period_start:new Date('2099-01-01'),period_end:new Date('2099-01-31'),pay_date:new Date('2099-01-31'),rate_version_id:version.id,rates_snapshot:{...resolved,capturedAt:new Date().toISOString()}}})
    await assert.rejects(cancelPayrollRates(db,scope,version.id,{reason:'No puede cancelarse aplicada'}),e=>e.status===409)
    let release,started
    const gate=new Promise(r=>release=r),ready=new Promise(r=>started=r)
    const confirm=db.$transaction(async tx=>{await lockPayrollRun(tx,{id,companyId,branchId});started();await gate;await tx.payrollRun.update({where:{id},data:{status:'CONFIRMADA'}})},{timeout:15000})
    await ready
    const recalc=db.$transaction(async tx=>{const run=await lockPayrollRun(tx,{id,companyId,branchId});assert.equal(run.status,'CONFIRMADA');return run},{timeout:15000})
    release();await confirm;const run=await recalc;assert.equal(run.rates_snapshot.rates.igssLaboral,.0483)
    await db.payrollRun.delete({where:{id}});await cancelPayrollRates(db,scope,version.id,{reason:'Ensayo terminado'})
    assert.equal((await resolvePayrollRates(db,companyId,'2099-01-01')).source,'baseline')
  }finally{
    await db.payrollRun.deleteMany({where:{company_id:companyId}});await db.branch.deleteMany({where:{id:branchId}});await db.company.deleteMany({where:{id:companyId}});await db.$disconnect()
  }
})
