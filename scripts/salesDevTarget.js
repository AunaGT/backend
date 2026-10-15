const {createHash}=require('node:crypto')
function connectionIdentity(connectionUrl){
  const url=new URL(connectionUrl)
  return createHash('sha256').update([url.hostname,decodeURIComponent(url.username),decodeURIComponent(url.pathname.slice(1))].join('|')).digest('hex')
}
function assertDevTarget({connectionUrl,approvedHost,approvedDatabase,approved,approvedIdentity}){
  if(approved!==true)throw Error('Explicit development approval required')
  const url=new URL(connectionUrl)
  if(!['postgresql:','postgres:'].includes(url.protocol))throw Error('PostgreSQL protocol required')
  if(url.searchParams.has('schema')&&url.searchParams.get('schema')!=='public')throw Error('Only existing public schema is allowed')
  const database=decodeURIComponent(url.pathname.slice(1))
  if(url.hostname!==approvedHost||database!==approvedDatabase)throw Error('Development destination mismatch')
  if(!approvedIdentity||connectionIdentity(connectionUrl)!==approvedIdentity)throw Error('Development project identity mismatch')
  return {host:url.hostname,database}
}
function approvedDevTarget(connectionUrl){
  return assertDevTarget({connectionUrl,approvedHost:process.env.AUNA_DEV_DB_HOST,approvedDatabase:process.env.AUNA_DEV_DB_NAME,
    approved:process.env.AUNA_DEV_DB_APPROVAL==='YES',approvedIdentity:process.env.AUNA_DEV_DB_IDENTITY})
}
module.exports={connectionIdentity,assertDevTarget,approvedDevTarget}
