const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto')
const fail=code=>{throw Object.assign(new Error(`${code}: usa la cadena baseline actual; el SQL anterior es solo histórico`),{code})}
function createMigrationResolver(root){
  const active=path.join(root,'prisma/migrations'),archive=path.join(root,'prisma/migrations-archive/pre-baseline-20261015')
  function migrationSqlPath(name,{historical=false}={}){
    if(!/^[A-Za-z0-9_]+$/.test(name))fail('MIGRATION_NAME_INVALID')
    const current=path.join(active,name,'migration.sql'),old=path.join(archive,name,'migration.sql')
    if(fs.existsSync(current)&&fs.existsSync(old))fail('MIGRATION_DUPLICATED')
    if(fs.existsSync(current))return current
    if(!fs.existsSync(old))fail('MIGRATION_NOT_FOUND')
    if(!historical)fail('MIGRATION_ARCHIVED')
    const entry=JSON.parse(fs.readFileSync(path.join(archive,'manifest.json'),'utf8')).migrations.find(m=>m.name===name)
    if(!entry||createHash('sha256').update(fs.readFileSync(old)).digest('hex')!==entry.checksum)fail('MIGRATION_CHECKSUM_MISMATCH')
    return old
  }
  return {migrationSqlPath,assertActiveMigration:name=>migrationSqlPath(name)}
}
module.exports={createMigrationResolver,...createMigrationResolver(path.resolve(__dirname,'..'))}
