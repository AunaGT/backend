const KINDS = ['SCANNER','RECEIPT_PRINTER','LABEL_PRINTER','OFFICE_PRINTER','CASH_DRAWER']
const ROLES = {SCANNER:'SCANNER',RECEIPT:'RECEIPT_PRINTER',LABEL:'LABEL_PRINTER',OFFICE:'OFFICE_PRINTER',DRAWER:'CASH_DRAWER'}
function fail(status,message,fields) { throw Object.assign(new Error(message),{status,fields}) }
function invalid(field,message='Revisa este valor') { fail(400,'Revisa los datos del equipo',{[field]:message}) }
function object(value,keys,field='form') {
  if(!value||Array.isArray(value)||typeof value!=='object') invalid(field)
  for(const key of Object.keys(value)) if(!keys.includes(key)&&value[key]!==undefined) invalid(field==='form'?key:`${field}.${key}`,'Opción no admitida')
  return value
}
function text(value,field,max,optional=false) {
  if(optional&&value==null)return ''
  if(typeof value!=='string'||value.trim().length>max||(!optional&&!value.trim())) invalid(field,`Usa entre ${optional?0:1} y ${max} caracteres`)
  return value.trim()
}
function uuid(value,field) { if(typeof value!=='string'||!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value))invalid(field,'Identificador inválido');return value }
function number(value,field,min,max,integer=false) { if(typeof value!=='number'||!Number.isFinite(value)||value<min||value>max||(integer&&!Number.isInteger(value)))invalid(field,`Usa ${integer?'un entero':'un número'} entre ${min} y ${max}`);return value }
function choice(value,choices,field) { if(!choices.includes(value))invalid(field,'Selecciona una opción válida');return value }
function version(input,required=false) { if(input.expectedVersion==null){if(required)invalid('expectedVersion','Actualiza el registro antes de guardar');return {}}return{expectedVersion:number(input.expectedVersion,'expectedVersion',1,2147483647,true)} }
function common(input) { return{code:text(input.code,'code',40),name:text(input.name,'name',120),notes:text(input.notes,'notes',500,true),state:choice(input.state,['DRAFT','ACTIVE','DISABLED'],'state'),...version(input)} }
function validateWorkstation(input) {
  object(input,['code','name','notes','state','cashRegisterId','expectedVersion'])
  return{...common(input),cashRegisterId:input.cashRegisterId==null||input.cashRegisterId===''?null:uuid(input.cashRegisterId,'cashRegisterId')}
}
function validateDevice(input) {
  object(input,['code','name','notes','state','kind','connection','profile','expectedVersion'])
  const kind=choice(input.kind,KINDS,'kind'),connection=choice(input.connection,kind==='SCANNER'?['HID']:kind==='CASH_DRAWER'?['PRINTER_PORT']:['SYSTEM_PRINTER'],'connection')
  const allowed=kind==='SCANNER'?['scannerSuffix','scannerMinLength','scannerMaxLength']:kind==='CASH_DRAWER'?['parentPrinterId']:['widthMm','heightMm','dpi','orientation','offsetXMm','offsetYMm','copies']
  const raw=object(input.profile||{},allowed,'profile'),profile={}
  for(const key of Object.keys(raw)) {
    const value=raw[key];if(value===undefined)continue
    if(key==='parentPrinterId')profile[key]=uuid(value,`profile.${key}`)
    else if(key==='orientation')profile[key]=choice(value,['portrait','landscape'],`profile.${key}`)
    else if(key==='scannerSuffix')profile[key]=choice(value,['ENTER','TAB','NONE'],`profile.${key}`)
    else {const [min,max,int]=key==='dpi'?[100,1200,true]:key==='copies'?[1,100,true]:key.startsWith('scanner')?[1,128,true]:key.startsWith('offset')?[-20,20,false]:[10,420,false];profile[key]=number(value,`profile.${key}`,min,max,int)}
  }
  if((profile.scannerMinLength??1)>(profile.scannerMaxLength??128))invalid('profile.scannerMaxLength','Debe ser mayor o igual al mínimo')
  if(kind==='CASH_DRAWER'&&!profile.parentPrinterId)invalid('profile.parentPrinterId','Selecciona la impresora de tickets de esta gaveta')
  return{...common(input),kind,connection,profile}
}
function validateAssignments(input) {
  object(input,['expectedVersion','assignments']);const result=version(input,true)
  if(!Array.isArray(input.assignments)||input.assignments.length>5)invalid('assignments')
  const seen=new Set(),assignments=input.assignments.map(raw=>{object(raw,['role','deviceId']);const role=choice(raw.role,Object.keys(ROLES),'assignments');if(seen.has(role))invalid('assignments','Cada función admite un solo equipo');seen.add(role);return{role,deviceId:uuid(raw.deviceId,'assignments')}})
  return{...result,assignments}
}
function validateTest(input) {
  object(input,['requestKey','workstationId','deviceId','kind','mode','outcome','sampleCode'])
  const result={requestKey:uuid(input.requestKey,'requestKey'),workstationId:uuid(input.workstationId,'workstationId'),deviceId:uuid(input.deviceId,'deviceId'),
    kind:choice(input.kind,['SCAN_INPUT','TICKET_SAMPLE','LABEL_SAMPLE','OFFICE_SAMPLE','DRAWER_SIMULATION'],'kind'),mode:choice(input.mode,['SIMULATED','BROWSER'],'mode'),outcome:choice(input.outcome,['SIMULATED','PREPARED','INPUT_RECEIVED','ERROR'],'outcome')}
  if(result.kind==='DRAWER_SIMULATION'&&(result.mode!=='SIMULATED'||result.outcome!=='SIMULATED'))invalid('mode','Esta prueba solo admite simulación')
  if(result.mode==='SIMULATED'&&!['SIMULATED','ERROR'].includes(result.outcome))invalid('outcome')
  if(result.mode==='BROWSER'&&result.outcome!==(result.kind==='SCAN_INPUT'?'INPUT_RECEIVED':'PREPARED')&&result.outcome!=='ERROR')invalid('outcome')
  if(result.kind==='SCAN_INPUT'&&result.mode==='BROWSER'&&result.outcome==='INPUT_RECEIVED'){
    if(typeof input.sampleCode!=='string'||!input.sampleCode.length||input.sampleCode.length>128||/[\x00-\x1f\x7f]/.test(input.sampleCode))invalid('sampleCode','Ingresa entre 1 y 128 caracteres sin saltos de línea')
    result.sampleCode=input.sampleCode
  }else if(input.sampleCode!==undefined)invalid('sampleCode','Solo se guarda el código en una prueba de lectura')
  return result
}
module.exports={KINDS,ROLES,fail,uuid,validateWorkstation,validateDevice,validateAssignments,validateTest,version}
