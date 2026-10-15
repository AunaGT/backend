#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),os=require('node:os')
const {createHash}=require('node:crypto')
require('../src/config/loadEnv')
const {approvedDevTarget}=require('./salesDevTarget')
const {readRoleSnapshot,planRoleNormalization,snapshotHash,applyRoleNormalization,verifyRoleNormalization}=require('../src/modules/users/roles/normalization')
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
async function main() {
 const args=Object.fromEntries(process.argv.slice(2).map(a=>{const [k,...v]=a.replace(/^--/,'').split('=');return [k,v.join('=')]}))
 if(!['inspect','apply','verify'].includes(args.mode))throw Error('Usa --mode=inspect|apply|verify')
 const url=process.env.DIRECT_URL,target=approvedDevTarget(url),{PrismaClient}=require('@prisma/client')
 const db=new PrismaClient({datasources:{db:{url}}})
 try {
  if(args.mode==='inspect') {
   const snapshot=await readRoleSnapshot(db),plan=planRoleNormalization(snapshot)
   const dir=fs.mkdtempSync(path.join(os.homedir(),'.local','state','auna-roles-'))
   fs.chmodSync(dir,0o700)
   const file=path.join(dir,'before.json'),record={target,identity:process.env.AUNA_DEV_DB_IDENTITY,createdAt:new Date().toISOString(),snapshot,checksum:hash(snapshot)}
   fs.writeFileSync(file,JSON.stringify(record,null,2),{mode:0o600,flag:'wx'})
   console.log(JSON.stringify({snapshot:file,roles:snapshot.roles.length,memberships:snapshot.memberships.length,copies:plan.copies.length,adminAliases:plan.adminAliasIds,conflicts:plan.conflicts,unresolved:plan.unresolved},null,2))
   if(plan.conflicts.length)process.exitCode=2
   return
  }
  if(!args.snapshot||!path.isAbsolute(args.snapshot)||path.resolve(args.snapshot).startsWith('/tmp/'))throw Error('Snapshot privado persistente requerido')
  const info=fs.lstatSync(args.snapshot)
  if(!info.isFile()||info.isSymbolicLink()||(info.mode&0o077)||info.uid!==process.getuid())throw Error('Snapshot debe ser propio, regular y privado (0600)')
  const record=JSON.parse(fs.readFileSync(args.snapshot,'utf8'))
  if(record.identity!==process.env.AUNA_DEV_DB_IDENTITY||hash(record.snapshot)!==record.checksum)throw Error('Snapshot no coincide con destino o checksum')
  if(args.mode==='verify') {
   const result=verifyRoleNormalization(record.snapshot,await readRoleSnapshot(db));console.log(JSON.stringify(result,null,2));if(!result.ok)process.exitCode=2;return
  }
  const result=await db.$transaction(async tx=>{
   await tx.$executeRaw`LOCK TABLE roles, role_permissions, users, user_companies, user_branches IN SHARE ROW EXCLUSIVE MODE`
   const current=await readRoleSnapshot(tx)
   if(snapshotHash(current)!==snapshotHash(record.snapshot))throw Error('Los datos cambiaron después del snapshot; vuelve a inspeccionar antes de aplicar')
   return applyRoleNormalization(tx,current)
  },{timeout:60000,maxWait:5000})
  const file=path.join(path.dirname(args.snapshot),'after.json');fs.writeFileSync(file,JSON.stringify({snapshot:result.after,verification:result.verification},null,2),{mode:0o600,flag:'wx'})
  console.log(JSON.stringify({applied:true,copies:result.plan.copies.length,verification:result.verification,after:file},null,2))
 }finally{await db.$disconnect()}
}
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1})
module.exports={main}
