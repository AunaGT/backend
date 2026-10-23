const test = require('node:test'), assert = require('node:assert/strict')
const v = require('../src/modules/config/hardware/validation')
const id = '10000000-0000-4000-8000-000000000001'
const workstation = {code:' PC-1 ',name:' Mostrador ',state:'DRAFT',cashRegisterId:null}
const scanner = {code:'L1',name:'Lector',kind:'SCANNER',connection:'HID',state:'DRAFT',profile:{scannerSuffix:'ENTER',scannerMinLength:1,scannerMaxLength:128}}
test('scanner accepts an optional printable prefix but not controls or oversized prefixes',()=>{
 assert.equal(v.validateDevice({...scanner,profile:{...scanner.profile,scannerPrefix:'~'}}).profile.scannerPrefix,'~')
 for(const scannerPrefix of ['\n','012345678',12])assert.throws(()=>v.validateDevice({...scanner,profile:{...scanner.profile,scannerPrefix}}),e=>e.status===400)
})
test('workstation normalizes names without accepting client tenant or stale versions',()=>{
  assert.deepEqual(v.validateWorkstation(workstation),{...workstation,code:'PC-1',name:'Mostrador',notes:''})
  for(const input of [{...workstation,companyId:id},{...workstation,expectedVersion:0},{...workstation,cashRegisterId:'no'},{...workstation,name:' '}]) assert.throws(()=>v.validateWorkstation(input),e=>e.status===400&&!!e.fields)
})
test('device profiles reject unsafe and inapplicable data, retain scanner suffix and leading zero bounds',()=>{
  assert.equal(v.validateDevice(scanner).profile.scannerSuffix,'ENTER')
  for(const profile of [{widthMm:80},{...scanner.profile,copies:101},{...scanner.profile,scannerMaxLength:129},{...scanner.profile,scannerMinLength:50,scannerMaxLength:2},{...scanner.profile,scannerSuffix:'ANY'}]) assert.throws(()=>v.validateDevice({...scanner,profile}),e=>e.status===400)
  for(const widthMm of [NaN,Infinity,9,421]) assert.throws(()=>v.validateDevice({...scanner,kind:'LABEL_PRINTER',connection:'SYSTEM_PRINTER',profile:{widthMm}}))
  assert.throws(()=>v.validateDevice({...scanner,kind:'CASH_DRAWER',connection:'PRINTER_PORT',profile:{parentPrinterId:id,voltage:24}}))
  assert.equal(v.validateDevice({...scanner,kind:'RECEIPT_PRINTER',connection:'SYSTEM_PRINTER',profile:{widthMm:80,heightMm:200,dpi:203,copies:1}}).profile.widthMm,80)
  assert.throws(()=>v.validateDevice({...scanner,connection:'SYSTEM_PRINTER'}))
})
test('assignments require version and unique roles without tenant supplied fields',()=>{
  assert.deepEqual(v.validateAssignments({expectedVersion:2,assignments:[{role:'SCANNER',deviceId:id}]}).assignments,[{role:'SCANNER',deviceId:id}])
  assert.throws(()=>v.validateAssignments({expectedVersion:2,assignments:[{role:'SCANNER',deviceId:id},{role:'SCANNER',deviceId:id}]}))
  assert.throws(()=>v.validateAssignments({assignments:[]}))
})
test('diagnostics cannot certify printing or open drawers and validate all combinations',()=>{
  const base={requestKey:id,workstationId:id,deviceId:id,kind:'SCAN_INPUT',mode:'BROWSER',outcome:'INPUT_RECEIVED',sampleCode:'00123'}
  assert.equal(v.validateTest(base).sampleCode,'00123')
  for(const input of [{...base,outcome:'PRINTED'},{...base,kind:'DRAWER_SIMULATION'},{...base,mode:'SIMULATED'},{...base,sampleCode:'1'.repeat(129)},{...base,sampleCode:''}]) assert.throws(()=>v.validateTest(input))
  assert.equal(v.validateTest({...base,kind:'DRAWER_SIMULATION',mode:'SIMULATED',outcome:'SIMULATED',sampleCode:undefined}).outcome,'SIMULATED')
})
