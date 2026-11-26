const {object,pageQuery,SCOPES,fail}=require('./credentials')
function parseCredentialQuery(query={},now=new Date()){
 object(query,['page','pageSize','q','status','scope'])
 for(const value of Object.values(query))if(value!==undefined&&typeof value!=='string'&&typeof value!=='number')fail(400)
 const {page,pageSize}=pageQuery({page:query.page,pageSize:query.pageSize})
 const status=query.status??'ALL'
 if(!['ALL','ACTIVE','PAUSED','EXPIRED','REVOKED'].includes(status)||query.scope!==undefined&&!SCOPES.includes(query.scope))fail(400)
 if(query.q!==undefined&&(typeof query.q!=='string'||query.q.length>100||/[\x00-\x1f\x7f]|auna_live_|authorization|bearer/i.test(query.q)))fail(400)
 const filters=[],q=query.q?.trim()
 if(q){const literal=q.replace(/[\\%_]/g,'\\$&');filters.push({OR:[{name:{contains:literal,mode:'insensitive'}},{public_id:{contains:literal,mode:'insensitive'}}]})}
 if(query.scope)filters.push({scopes:{has:query.scope}})
 if(status==='REVOKED')filters.push({revoked_at:{not:null}})
 else if(status!=='ALL'){
  filters.push({revoked_at:null})
  if(status==='EXPIRED')filters.push({expires_at:{lte:now}})
  else filters.push({OR:[{expires_at:null},{expires_at:{gt:now}}]},{paused_at:status==='PAUSED'?{not:null}:null})
 }
 return{page,pageSize,where:filters.length?{AND:filters}:{}}
}
module.exports={parseCredentialQuery}
