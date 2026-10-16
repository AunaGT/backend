// Retired: the audited baseline includes this migration. Never replay it.
if(require.main===module){
  try{require('./migrationFiles').assertActiveMigration('20261005120000_hr_employee_documents')}
  catch(error){console.error(error.message);process.exitCode=1}
}
