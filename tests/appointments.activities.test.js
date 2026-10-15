const test=require('node:test'),assert=require('node:assert/strict')
test('actividades exponen comandos separados de las reservas comerciales',()=>{
  const activity=require('../src/modules/appointments/activities')
  for(const name of ['createActivity','updateActivity','transitionActivity','getActivity','listActivityUsers']) assert.equal(typeof activity[name],'function')
})
test('alcance propio incluye organizador y participante sin dar acceso al equipo',()=>{
  const {appointmentWhere}=require('../src/modules/appointments/access')
  const where=appointmentWhere({companyId:'company',branchId:'branch',userId:'user',permissions:[],isAdmin:false})
  assert.equal(where.company_id,'company');assert.equal(where.branch_id,'branch')
  assert.ok(where.OR.some(x=>x.organizer_id==='user'))
  assert.ok(where.OR.some(x=>x.participants?.some?.user_id==='user'))
})
test('detalle libre no lee registros si Agenda está deshabilitada',async()=>{
  const {getActivity}=require('../src/modules/appointments/activities')
  const db={companyModule:{findMany:async()=>[{module_code:'appointments',status:'DISABLED'}]},appointmentSession:{findFirst:async()=>{throw Error('No leer Agenda deshabilitada')}}}
  await assert.rejects(()=>getActivity(db,{companyId:'company',branchId:'branch',userId:'user',isAdmin:true,permissions:[]},'00000000-0000-4000-8000-000000000001'),{status:403})
})
