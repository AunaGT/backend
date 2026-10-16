// Retired: the former 20250829 path never existed in this chain; do not recreate it.
if(require.main===module){
  try{require('./migrationFiles').assertActiveMigration('20260930120000_returns_settlement')}
  catch(error){console.error(error.message);process.exitCode=1}
}
