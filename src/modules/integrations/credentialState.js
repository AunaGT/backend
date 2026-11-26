const {isExpired}=require('./credentials')
function credentialState(row,now=new Date()){
 if(row?.revoked_at)return 'REVOKED'
 if(!row||isExpired(row.expires_at,now))return 'EXPIRED'
 return row.paused_at?'PAUSED':'ACTIVE'
}
const credentialUnavailable=(row,now)=>credentialState(row,now)!=='ACTIVE'
module.exports={credentialState,credentialUnavailable}
