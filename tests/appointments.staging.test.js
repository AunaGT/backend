const test=require('node:test'),assert=require('node:assert/strict')
test('commercial delta requires its own approval and a restoration proof bound to backup, target and prior migrations',()=>{
  const {selectAppointmentsMigration,stagingUrl,validateRestoreProof}=require('../scripts/appointments-staging')
  assert.equal(selectAppointmentsMigration('commercial'),'202610130001_appointments_commercial')
  const env={APPOINTMENTS_MIGRATION:'commercial',APPOINTMENTS_STAGING_DATABASE_URL:'postgresql://user:secret@localhost:5432/qa',AUNA_APPOINTMENTS_STAGING_APPROVAL:'approved',APPOINTMENTS_CONFIRM_HOST:'localhost:5432',APPOINTMENTS_CONFIRM_DATABASE:'qa'}
  assert.throws(()=>stagingUrl(env),/aprobación.*comercial/i)
  assert.doesNotThrow(()=>stagingUrl({...env,AUNA_APPOINTMENTS_COMMERCIAL_APPROVAL:'approved'}))
  assert.equal(typeof validateRestoreProof,'function')
  const receipt={sha256:'backup',restoreVerifiedChecksum:'backup',restoreMigrationChecksum:'delta',restoreVerifiedAt:'2026-10-13T12:00:00Z',restoreTarget:'127.0.0.1:55439/qa',priorMigrationChecksums:{core:'a',flexible:'b',unified:'c'}}
  const expected={core:'a',flexible:'b',unified:'c'},now=new Date('2026-10-13T13:00:00Z').getTime()
  assert.doesNotThrow(()=>validateRestoreProof(receipt,'delta',expected,now))
  for(const patch of [{restoreVerifiedChecksum:'wrong'},{restoreMigrationChecksum:'wrong'},{restoreTarget:'remote/db'},{restoreVerifiedAt:'2026-10-11T12:00:00Z'},{priorMigrationChecksums:{...expected,unified:'wrong'}}])assert.throws(()=>validateRestoreProof({...receipt,...patch},'delta',expected,now))
})
test('unified rechaza comprobante de otra delta',()=>{
  const {selectAppointmentsMigration,validateBackupReceipt}=require('../scripts/appointments-staging')
  assert.equal(selectAppointmentsMigration('unified'),'202610120004_appointments_unified_services')
  const now=Date.now(),raw='postgresql://user:secret@localhost:5432/qa'
  const receipt={host:'localhost:5432',database:'qa',migration:'202610120003_appointments_flexible',migrationChecksum:'hash',createdAt:new Date(now).toISOString()}
  assert.throws(()=>validateBackupReceipt(raw,receipt,'unified','hash',now))
})
test('selector permite solo core o flexible y comprobante identifica la migración',()=>{
  const {selectAppointmentsMigration,validateBackupReceipt}=require('../scripts/appointments-staging')
  assert.equal(selectAppointmentsMigration('flexible'),'202610120003_appointments_flexible')
  assert.equal(selectAppointmentsMigration(),'202610120002_appointments_core')
  assert.throws(()=>selectAppointmentsMigration('../../otra'))
  const raw='postgresql://user:secret@localhost:5432/qa',now=Date.now()
  const receipt={host:'localhost:5432',database:'qa',migration:'202610120003_appointments_flexible',migrationChecksum:'hash',createdAt:new Date(now).toISOString()}
  assert.doesNotThrow(()=>validateBackupReceipt(raw,receipt,'flexible','hash',now))
  assert.throws(()=>validateBackupReceipt(raw,receipt,'core','hash',now))
  assert.throws(()=>validateBackupReceipt(raw,{...receipt,createdAt:new Date(now-86400001).toISOString()},'flexible','hash',now))
  assert.throws(()=>validateBackupReceipt(raw,{...receipt,host:'other'},'flexible','hash',now))
  assert.throws(()=>validateBackupReceipt(raw,receipt,'flexible','wrong',now))
})
test('despliegue exige URL explícita, aprobación y coincidencia del destino sin filtrar secretos',()=>{
  const {stagingUrl}=require('../scripts/appointments-staging')
  for(const env of [{},{DIRECT_URL:'postgresql://user:secret@target/db'},{APPOINTMENTS_STAGING_DATABASE_URL:'postgresql://user:secret@target/db',AUNA_APPOINTMENTS_STAGING_APPROVAL:'approved',APPOINTMENTS_CONFIRM_HOST:'wrong',APPOINTMENTS_CONFIRM_DATABASE:'db'}]){
    assert.throws(()=>stagingUrl(env),error=>!error.message.includes('secret'))
  }
  const env={APPOINTMENTS_STAGING_DATABASE_URL:'postgresql://user:secret@localhost:5432/qa?schema=public',AUNA_APPOINTMENTS_STAGING_APPROVAL:'approved',APPOINTMENTS_CONFIRM_HOST:'localhost:5432',APPOINTMENTS_CONFIRM_DATABASE:'qa'}
  assert.equal(new URL(stagingUrl(env)).searchParams.get('schema'),'public')
})
