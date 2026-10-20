const {createHash}=require('node:crypto')
const v=require('./validation'),p=require('./presentation')
const conflict=()=>v.fail(409,'La configuración cambió. Actualiza los datos antes de guardar otra vez.')
function permission(scope,code){if(!scope.isAdmin&&!scope.permissions?.includes(code))v.fail(403,'No tienes permiso para esta acción')}
function where(scope){if(!scope.companyId)v.fail(400,'Selecciona una empresa');return{company_id:scope.companyId,branch_id:scope.branchId||{in:scope.branchIds||[]}}}
function writeScope(scope,code='hardware.manage'){permission(scope,code);if(!scope.branchId||scope.isConsolidated)v.fail(400,'Selecciona una sucursal; el consolidado es solo de consulta')}
async function transaction(db,scope,code,run){
  writeScope(scope,code)
  try{return await db.$transaction(async tx=>{
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`hardware:${scope.companyId}:${scope.branchId}`},0))`
    return run(tx)
  },{maxWait:10000,timeout:20000})}catch(error){if(['P2002','P2034'].includes(error.code))conflict();throw error}
}
async function scopedRow(tx,scope,model,id){v.uuid(id,'id');const row=await tx[model].findFirst({where:{...where(scope),id}});if(!row)v.fail(404,'Registro no encontrado en esta sucursal');return row}
async function checkRegister(tx,scope,id){
  if(!id)return
  const row=await tx.cashRegister.findFirst({where:{id,branch_id:scope.branchId}})
  if(!row)v.fail(404,'Caja no encontrada en esta sucursal')
  if(!row.active)v.fail(400,'La caja está deshabilitada',{cashRegisterId:'Selecciona una caja activa'})
}
async function blockOpenRegisters(tx,scope,ids){
  for(const id of [...new Set(ids.filter(Boolean))].sort()){
    await tx.$queryRaw`SELECT id FROM cash_registers WHERE id=${id}::uuid AND branch_id=${scope.branchId}::uuid FOR UPDATE`
    if(await tx.cashRegisterSession.findFirst({where:{cash_register_id:id,status:'OPEN'}}))v.fail(409,'Cierra el turno de caja antes de cambiar sus equipos o asignaciones')
  }
}
async function audit(tx,scope,action,id,before,after){
  return tx.hardwareAuditEvent.create({data:{company_id:scope.companyId,branch_id:scope.branchId,actor_id:scope.actorId,action,entity_id:id,
    ...(before?{before:JSON.parse(JSON.stringify(before))}:{}),...(after?{after:JSON.parse(JSON.stringify(after))}:{})}})
}
function pageInput(raw={}){
  const page=Number(raw.page??1),pageSize=Number(raw.pageSize??10)
  if(!Number.isSafeInteger(page)||page<1||!Number.isSafeInteger(pageSize)||pageSize<1||pageSize>100)v.fail(400,'Paginación inválida')
  return{page,pageSize}
}
async function workspace(db,scope,raw={}){
  permission(scope,'hardware.view');const scoped=where(scope),paging=pageInput(raw)
  const [stations,devices,assignments,registers]=await Promise.all([
    db.hardwareWorkstation.findMany({where:scoped,orderBy:[{name:'asc'},{id:'asc'}]}),
    db.hardwareDevice.findMany({where:scoped,orderBy:[{name:'asc'},{id:'asc'}]}),
    db.hardwareAssignment.findMany({where:scoped}),
    db.cashRegister.findMany({where:{branch_id:scoped.branch_id,branch:{company_id:scope.companyId}},orderBy:[{name:'asc'},{id:'asc'}],select:{id:true,branch_id:true,name:true,code:true,active:true}}),
  ])
  return{workstations:stations.map(p.workstation),devices:devices.map(p.device),assignments:assignments.map(p.assignment),registers:registers.map(r=>({id:r.id,branchId:r.branch_id,name:r.name,code:r.code,active:r.active})),totalItems:stations.length,...paging,totalPages:Math.max(1,Math.ceil(stations.length/paging.pageSize))}
}
async function saveWorkstation(db,scope,id,input){
  const value=v.validateWorkstation(input);if(id)v.version(value,true)
  return transaction(db,scope,'hardware.manage',async tx=>{
    const before=id?await scopedRow(tx,scope,'hardwareWorkstation',id):null
    if(before&&before.version!==value.expectedVersion)conflict()
    await checkRegister(tx,scope,value.cashRegisterId)
    if(!before||before.cash_register_id!==value.cashRegisterId||before.state!==value.state)await blockOpenRegisters(tx,scope,[before?.cash_register_id,value.cashRegisterId])
    if(value.state==='ACTIVE'&&value.cashRegisterId){
      const other=await tx.hardwareWorkstation.findFirst({where:{...where(scope),cash_register_id:value.cashRegisterId,state:'ACTIVE',...(id?{NOT:{id}}:{})}})
      if(other)v.fail(409,'Esta caja ya tiene un puesto activo')
    }
    if(before){
      const assignments=await tx.hardwareAssignment.findMany({where:{...where(scope),workstation_id:id}})
      if(!value.cashRegisterId&&assignments.some(a=>a.role==='DRAWER'))v.fail(400,'Quita la asignación de gaveta antes de retirar la caja')
      if(value.state==='ACTIVE')await checkAssignments(tx,scope,{...before,state:value.state,cash_register_id:value.cashRegisterId},assignments.map(a=>({role:a.role,deviceId:a.device_id})))
    }
    const data={code:value.code,name:value.name,notes:value.notes,state:value.state,cash_register_id:value.cashRegisterId}
    let row
    if(before){const changed=await tx.hardwareWorkstation.updateMany({where:{...where(scope),id,version:value.expectedVersion},data:{...data,version:{increment:1}}});if(changed.count!==1)conflict();row=await scopedRow(tx,scope,'hardwareWorkstation',id)}
    else row=await tx.hardwareWorkstation.create({data:{...data,company_id:scope.companyId,branch_id:scope.branchId}})
    await audit(tx,scope,before?'WORKSTATION_UPDATED':'WORKSTATION_CREATED',row.id,before&&p.workstation(before),p.workstation(row));return p.workstation(row)
  })
}
async function checkAssignments(tx,scope,station,assignments){
  const devices=new Map()
  for(const a of assignments){const d=await scopedRow(tx,scope,'hardwareDevice',a.deviceId);if(d.kind!==v.ROLES[a.role])v.fail(400,'El equipo no corresponde a la función seleccionada');if(d.state==='DISABLED'||(station.state==='ACTIVE'&&d.state!=='ACTIVE'))v.fail(400,'El equipo debe estar activo para este puesto');devices.set(a.role,d)}
  if(devices.has('DRAWER')){
    if(!station.cash_register_id||!devices.has('RECEIPT')||devices.get('DRAWER').profile.parentPrinterId!==devices.get('RECEIPT').id)v.fail(400,'La gaveta necesita una caja y su impresora de tickets asignada',{assignments:'Revisa la caja y la ruta de la gaveta'})
    if(station.state==='ACTIVE'){
      const links=await tx.hardwareAssignment.findMany({where:{...where(scope),device_id:devices.get('DRAWER').id,role:'DRAWER',NOT:{workstation_id:station.id}}})
      if(links.length&&await tx.hardwareWorkstation.findFirst({where:{...where(scope),id:{in:links.map(a=>a.workstation_id)},state:'ACTIVE'}}))v.fail(409,'Esta gaveta ya pertenece a otro puesto habilitado. Usa una gaveta diferente o deshabilita primero el otro puesto.',{assignments:'Una gaveta no puede compartirse entre puestos habilitados'})
    }
  }
}
async function saveDevice(db,scope,id,input){
  const value=v.validateDevice(input);if(id)v.version(value,true)
  return transaction(db,scope,'hardware.manage',async tx=>{
    const before=id?await scopedRow(tx,scope,'hardwareDevice',id):null
    if(before&&before.version!==value.expectedVersion)conflict()
    if(value.kind==='CASH_DRAWER'){
      const parent=await scopedRow(tx,scope,'hardwareDevice',value.profile.parentPrinterId)
      if(parent.id===id||parent.kind!=='RECEIPT_PRINTER'||parent.state==='DISABLED')v.fail(400,'Selecciona una impresora de tickets habilitada de esta sucursal')
    }
    if(before){
      const assignments=await tx.hardwareAssignment.findMany({where:{...where(scope),device_id:id}})
      const stations=await Promise.all(assignments.map(a=>scopedRow(tx,scope,'hardwareWorkstation',a.workstation_id)))
      await blockOpenRegisters(tx,scope,stations.map(w=>w.cash_register_id))
      if(value.state!=='ACTIVE'&&stations.some(w=>w.state==='ACTIVE'))v.fail(409,'Este equipo está asignado a un puesto habilitado. Retíralo o deshabilita el puesto antes de cambiar su estado.')
      if(assignments.length&&(value.kind!==before.kind||value.state==='DISABLED'))v.fail(409,'Retira este equipo de sus puestos antes de cambiar su tipo o deshabilitarlo')
      const drawers=await tx.hardwareDevice.findMany({where:{...where(scope),kind:'CASH_DRAWER'}})
      if((value.state==='DISABLED'||value.kind!=='RECEIPT_PRINTER')&&drawers.some(d=>d.state!=='DISABLED'&&d.profile.parentPrinterId===id))v.fail(409,'Esta impresora tiene una gaveta habilitada; desvincúlala primero')
      if(value.kind==='CASH_DRAWER'&&value.profile.parentPrinterId!==before.profile.parentPrinterId&&assignments.length)v.fail(409,'Retira la gaveta de sus puestos antes de cambiar su impresora')
    }
    const data={code:value.code,name:value.name,notes:value.notes,state:value.state,kind:value.kind,connection:value.connection,profile:value.profile}
    let row
    if(before){const changed=await tx.hardwareDevice.updateMany({where:{...where(scope),id,version:value.expectedVersion},data:{...data,version:{increment:1}}});if(changed.count!==1)conflict();row=await scopedRow(tx,scope,'hardwareDevice',id)}
    else row=await tx.hardwareDevice.create({data:{...data,company_id:scope.companyId,branch_id:scope.branchId}})
    await audit(tx,scope,before?'DEVICE_UPDATED':'DEVICE_CREATED',row.id,before&&p.device(before),p.device(row));return p.device(row)
  })
}
async function assignDevices(db,scope,id,input){
  const value=v.validateAssignments(input)
  return transaction(db,scope,'hardware.manage',async tx=>{
    const station=await scopedRow(tx,scope,'hardwareWorkstation',id);if(station.version!==value.expectedVersion)conflict()
    await blockOpenRegisters(tx,scope,[station.cash_register_id]);await checkAssignments(tx,scope,station,value.assignments)
    const previous=await tx.hardwareAssignment.findMany({where:{...where(scope),workstation_id:id}})
    const changed=await tx.hardwareWorkstation.updateMany({where:{...where(scope),id,version:value.expectedVersion},data:{version:{increment:1}}});if(changed.count!==1)conflict()
    await tx.hardwareAssignment.deleteMany({where:{...where(scope),workstation_id:id}})
    if(value.assignments.length)await tx.hardwareAssignment.createMany({data:value.assignments.map(a=>({company_id:scope.companyId,branch_id:scope.branchId,workstation_id:id,device_id:a.deviceId,role:a.role}))})
    await audit(tx,scope,'ASSIGNMENTS_UPDATED',id,{assignments:previous.map(p.assignment)},{assignments:value.assignments})
    return p.workstation(await scopedRow(tx,scope,'hardwareWorkstation',id))
  })
}
async function recordTest(db,scope,input){
  const value=v.validateTest(input),required=value.kind==='DRAWER_SIMULATION'?'hardware.test_drawer':'hardware.test_print'
  permission(scope,'hardware.view')
  return transaction(db,scope,required,async tx=>{
    const hash=createHash('sha256').update(JSON.stringify(value)).digest('hex')
    const previous=await tx.hardwareTestRun.findUnique({where:{company_id_actor_id_request_key:{company_id:scope.companyId,actor_id:scope.actorId,request_key:value.requestKey}}})
    if(previous){if(previous.request_hash!==hash||previous.branch_id!==scope.branchId)v.fail(409,'La referencia de prueba ya se usó con otros datos');return p.testRun(previous)}
    const station=await scopedRow(tx,scope,'hardwareWorkstation',value.workstationId),device=await scopedRow(tx,scope,'hardwareDevice',value.deviceId)
    if(station.state==='DISABLED'||device.state==='DISABLED')v.fail(400,'Activa o deja en borrador el puesto y equipo para probarlos')
    const role={SCAN_INPUT:'SCANNER',TICKET_SAMPLE:'RECEIPT',LABEL_SAMPLE:'LABEL',OFFICE_SAMPLE:'OFFICE',DRAWER_SIMULATION:'DRAWER'}[value.kind]
    if(device.kind!==v.ROLES[role]||!await tx.hardwareAssignment.findFirst({where:{...where(scope),workstation_id:station.id,device_id:device.id,role}}))v.fail(400,'Asigna este equipo al puesto antes de probarlo')
    const row=await tx.hardwareTestRun.create({data:{company_id:scope.companyId,branch_id:scope.branchId,actor_id:scope.actorId,request_key:value.requestKey,request_hash:hash,workstation_id:station.id,device_id:device.id,kind:value.kind,mode:value.mode,outcome:value.outcome,sample_code:value.sampleCode||null}})
    return p.testRun(row)
  })
}
async function history(db,scope,raw={},tests=false){
  permission(scope,'hardware.view');const paging=pageInput(raw),model=tests?'hardwareTestRun':'hardwareAuditEvent',scoped=where(scope)
  const totalItems=await db[model].count({where:scoped}),totalPages=Math.max(1,Math.ceil(totalItems/paging.pageSize)),page=Math.min(paging.page,totalPages)
  const rows=await db[model].findMany({where:scoped,orderBy:[{created_at:'desc'},{id:'desc'}],skip:(page-1)*paging.pageSize,take:paging.pageSize})
  return{items:rows.map(tests?p.testRun:p.audit),totalItems,page,pageSize:paging.pageSize,totalPages}
}
module.exports={workspace,saveWorkstation,saveDevice,assignDevices,recordTest,history}
