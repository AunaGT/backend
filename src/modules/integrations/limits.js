const {fail}=require('./credentials')
async function consumeQuota(db,context,now=new Date()){
 const window=new Date(Math.floor(now.getTime()/60000)*60000)
 await db.$transaction(async tx=>{
  for(const [bucket,limit]of [[`company:${context.companyId}`,600],[`key:${context.credentialId}`,120]]){
   const rows=await tx.$queryRaw`INSERT INTO integration_rate_windows(bucket,window_at,count) VALUES(${bucket},${window},1)
    ON CONFLICT(bucket,window_at) DO UPDATE SET count=integration_rate_windows.count+1
    WHERE integration_rate_windows.count < ${limit} RETURNING count`
   if(!rows.length){try{fail(429,'RATE_LIMIT')}catch(e){e.retryAfter=Math.max(1,Math.ceil((window.getTime()+60000-now.getTime())/1000));throw e}}
  }
 })
}
module.exports={consumeQuota}
